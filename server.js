import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import webPush from "web-push";
import { WebSocketServer, WebSocket } from "ws";

const scrypt = promisify(scryptCallback);
const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT_DIR, "data");
const DATA_FILE = join(DATA_DIR, "messenger.json");
const VAPID_KEYS_FILE = join(DATA_DIR, "vapid-keys.json");
const PROFILE_AVATARS = new Set(["🐿️", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐸", "🐵", "🐰", "🦝", "🦉", "🦔", "🐹", "🐶", "🐱", "🐧", "🐤"]);
const CLIENT_FILES = new Map([
  ["/", "Index.html"],
  ["/Index.html", "Index.html"],
  ["/style.css", "style.css"],
  ["/app.js", "app.js"],
  ["/service-worker.js", "service-worker.js"],
  ["/manifest.webmanifest", "manifest.webmanifest"],
  ["/icon.svg", "icon.svg"],
  ["/icon-192.png", "icon-192.png"],
  ["/icon-512.png", "icon-512.png"],
  ["/apple-touch-icon.png", "apple-touch-icon.png"]
]);

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const envVapidKeys = process.env.VAPID_PUBLIC_KEY || process.env.VAPID_PRIVATE_KEY;
if (envVapidKeys && (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY)) {
  throw new Error("Для Web Push задайте одновременно VAPID_PUBLIC_KEY и VAPID_PRIVATE_KEY.");
}
const vapidKeys = envVapidKeys
  ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
  : existsSync(VAPID_KEYS_FILE)
    ? JSON.parse(readFileSync(VAPID_KEYS_FILE, "utf8"))
    : webPush.generateVAPIDKeys();
if (!envVapidKeys && !existsSync(VAPID_KEYS_FILE)) {
  writeFileSync(VAPID_KEYS_FILE, JSON.stringify(vapidKeys), { mode: 0o600 });
}
webPush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:admin@localhost",
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

let database = existsSync(DATA_FILE)
  ? JSON.parse(readFileSync(DATA_FILE, "utf8"))
  : { users: [], messages: [] };
const sessions = new Map();
const connections = new Map();

function saveDatabase() {
  const temporaryFile = `${DATA_FILE}.tmp`;
  writeFileSync(temporaryFile, JSON.stringify(database), { mode: 0o600 });
  renameSync(temporaryFile, DATA_FILE);
}

function jsonResponse(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 32_768) {
        reject(Object.assign(new Error("Запрос слишком большой"), { status: 413 }));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(body || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(Object.assign(new Error("Некорректный JSON"), { status: 400 }));
          return;
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error("Некорректный JSON"), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function findUser(id) {
  return database.users.find((user) => user.id === id);
}

function getRequestUser(request) {
  const authorization = request.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const userId = sessions.get(token);
  return userId ? findUser(userId) : undefined;
}

function sendToUser(userId, payload) {
  const sockets = connections.get(userId);
  if (!sockets) return;
  const message = JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }
}

function sendPushToUser(userId, payload) {
  const user = findUser(userId);
  if (!user || !Array.isArray(user.pushSubscriptions) || user.pushSubscriptions.length === 0) return;
  const subscriptions = [...user.pushSubscriptions];
  void Promise.allSettled(subscriptions.map((subscription) =>
    Promise.resolve().then(() => webPush.sendNotification(subscription, JSON.stringify(payload), { TTL: 120 }))
  )).then((results) => {
    const expiredEndpoints = new Set();
    results.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      if (result.reason?.statusCode === 404 || result.reason?.statusCode === 410) {
        expiredEndpoints.add(subscriptions[index].endpoint);
      } else {
        console.warn("Web Push send failed:", result.reason?.statusCode || result.reason?.message || String(result.reason));
      }
    });
    if (expiredEndpoints.size > 0) {
      user.pushSubscriptions = user.pushSubscriptions.filter((subscription) => !expiredEndpoints.has(subscription.endpoint));
      saveDatabase();
    }
  }).catch((error) => console.error("Web Push delivery failed:", error));
}

function isContact(user, otherId) {
  return user.contacts.includes(otherId);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    avatar: PROFILE_AVATARS.has(user.avatar) ? user.avatar : "",
    online: connections.has(user.id)
  };
}

function requireUser(request, response) {
  const user = getRequestUser(request);
  if (!user) {
    jsonResponse(response, 401, { error: "Сессия истекла. Войдите снова." });
    return undefined;
  }
  return user;
}

async function handleApi(request, response, url) {
  if (request.method === "POST" && url.pathname === "/api/register") {
    const body = await readBody(request);
    const username = String(body.username || "").trim().toLowerCase();
    const name = String(body.name || "").trim();
    const password = String(body.password || "");
    if (!/^[a-z0-9_]{3,30}$/.test(username)) {
      jsonResponse(response, 400, { error: "Никнейм: 3–30 символов, латинские буквы, цифры и _." });
      return;
    }
    if (name.length < 1 || name.length > 60) {
      jsonResponse(response, 400, { error: "Имя должно содержать от 1 до 60 символов." });
      return;
    }
    if (password.length < 8 || password.length > 128) {
      jsonResponse(response, 400, { error: "Пароль должен содержать от 8 до 128 символов." });
      return;
    }
    if (database.users.some((user) => user.username === username)) {
      jsonResponse(response, 409, { error: "Этот никнейм уже занят." });
      return;
    }
    const salt = randomBytes(16);
    const passwordHash = await scrypt(password, salt, 64);
    const user = {
      id: randomUUID(),
      username,
      name,
      avatar: "🐿️",
      salt: salt.toString("hex"),
      passwordHash: passwordHash.toString("hex"),
      contacts: [],
      pushSubscriptions: []
    };
    database.users.push(user);
    saveDatabase();
    const token = randomBytes(32).toString("base64url");
    sessions.set(token, user.id);
    jsonResponse(response, 201, { token, user: publicUser(user) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/login") {
    const body = await readBody(request);
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    const user = database.users.find((item) => item.username === username);
    if (!user) {
      jsonResponse(response, 401, { error: "Неверный никнейм или пароль." });
      return;
    }
    const hash = await scrypt(password, Buffer.from(user.salt, "hex"), 64);
    const expected = Buffer.from(user.passwordHash, "hex");
    if (hash.length !== expected.length || !timingSafeEqual(hash, expected)) {
      jsonResponse(response, 401, { error: "Неверный никнейм или пароль." });
      return;
    }
    const token = randomBytes(32).toString("base64url");
    sessions.set(token, user.id);
    jsonResponse(response, 200, { token, user: publicUser(user) });
    return;
  }

  const user = requireUser(request, response);
  if (!user) return;

  if (request.method === "GET" && url.pathname === "/api/me") {
    jsonResponse(response, 200, { user: publicUser(user) });
    return;
  }

  if (request.method === "PATCH" && url.pathname === "/api/profile") {
    const body = await readBody(request);
    if (typeof body.avatar !== "string" || !PROFILE_AVATARS.has(body.avatar)) {
      jsonResponse(response, 400, { error: "Выберите аватар из списка животных." });
      return;
    }
    user.avatar = body.avatar;
    saveDatabase();
    sendToUser(user.id, { type: "profile-updated", user: publicUser(user) });
    for (const contactId of user.contacts) sendToUser(contactId, { type: "contacts-updated" });
    jsonResponse(response, 200, { user: publicUser(user) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/rtc-config") {
    const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
    if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      iceServers.push({
        urls: process.env.TURN_URL,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL
      });
    }
    jsonResponse(response, 200, { iceServers });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/push/public-key") {
    jsonResponse(response, 200, { publicKey: vapidKeys.publicKey });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/push/subscribe") {
    const body = await readBody(request);
    const subscription = body.subscription;
    const endpoint = typeof subscription?.endpoint === "string" ? subscription.endpoint : "";
    const keys = subscription?.keys;
    let endpointUrl;
    try {
      endpointUrl = new URL(endpoint);
    } catch {
      jsonResponse(response, 400, { error: "Некорректная push-подписка." });
      return;
    }
    const hostname = endpointUrl.hostname.toLowerCase();
    const supportedPushHost = hostname === "fcm.googleapis.com" ||
      hostname === "updates.push.services.mozilla.com" ||
      hostname === "push.services.mozilla.com" ||
      hostname === "web.push.apple.com" ||
      hostname.endsWith(".notify.windows.com");
    if (
      endpoint.length > 2048 ||
      endpointUrl.protocol !== "https:" ||
      !supportedPushHost ||
      typeof keys?.p256dh !== "string" ||
      keys.p256dh.length > 256 ||
      typeof keys.auth !== "string" ||
      keys.auth.length > 256
    ) {
      jsonResponse(response, 400, { error: "Некорректная push-подписка." });
      return;
    }

    const subscriptions = Array.isArray(user.pushSubscriptions) ? user.pushSubscriptions : [];
    const existingIndex = subscriptions.findIndex((item) => item.endpoint === endpoint);
    const savedSubscription = { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
    if (existingIndex < 0 && subscriptions.length >= 10) {
      jsonResponse(response, 429, { error: "Достигнут лимит устройств для уведомлений." });
      return;
    }
    if (existingIndex < 0) subscriptions.push(savedSubscription);
    else subscriptions[existingIndex] = savedSubscription;
    user.pushSubscriptions = subscriptions;
    saveDatabase();
    jsonResponse(response, 201, { subscribed: true });
    return;
  }

  if (request.method === "DELETE" && url.pathname === "/api/push/subscribe") {
    const body = await readBody(request);
    const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
    if (!Array.isArray(user.pushSubscriptions) || !endpoint) {
      jsonResponse(response, 200, { subscribed: false });
      return;
    }
    user.pushSubscriptions = user.pushSubscriptions.filter((item) => item.endpoint !== endpoint);
    saveDatabase();
    jsonResponse(response, 200, { subscribed: false });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/contacts") {
    const contacts = user.contacts.map(findUser).filter(Boolean).map(publicUser);
    jsonResponse(response, 200, { contacts });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/contacts") {
    const body = await readBody(request);
    const username = String(body.username || "").trim().replace(/^@/, "").toLowerCase();
    const contact = database.users.find((item) => item.username === username);
    if (!contact) {
      jsonResponse(response, 404, { error: "Пользователь с таким никнеймом не найден." });
      return;
    }
    if (contact.id === user.id) {
      jsonResponse(response, 400, { error: "Нельзя добавить самого себя." });
      return;
    }
    if (isContact(user, contact.id)) {
      jsonResponse(response, 409, { error: "Этот контакт уже добавлен." });
      return;
    }
    user.contacts.push(contact.id);
    contact.contacts.push(user.id);
    saveDatabase();
    sendToUser(contact.id, { type: "contacts-updated" });
    jsonResponse(response, 201, { contact: publicUser(contact) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/chats") {
    const chats = user.contacts.map((contactId) => {
      const contact = findUser(contactId);
      if (!contact) return undefined;
      const lastMessage = database.messages
        .filter((message) =>
          (message.fromId === user.id && message.toId === contactId) ||
          (message.fromId === contactId && message.toId === user.id)
        )
        .at(-1);
      return lastMessage ? { ...publicUser(contact), lastMessage } : undefined;
    }).filter(Boolean).sort((a, b) => b.lastMessage.createdAt.localeCompare(a.lastMessage.createdAt));
    jsonResponse(response, 200, { chats });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/messages") {
    const contactId = url.searchParams.get("with");
    if (!contactId || !isContact(user, contactId)) {
      jsonResponse(response, 403, { error: "Сначала добавьте пользователя в контакты." });
      return;
    }
    const messages = database.messages.filter((message) =>
      (message.fromId === user.id && message.toId === contactId) ||
      (message.fromId === contactId && message.toId === user.id)
    );
    jsonResponse(response, 200, { messages });
    return;
  }

  jsonResponse(response, 404, { error: "Маршрут не найден." });
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    try {
      await handleApi(request, response, url);
    } catch (error) {
      console.error("API error:", error);
      if (!response.headersSent) {
        jsonResponse(response, error.status || 500, { error: error.status ? error.message : "Внутренняя ошибка сервера." });
      }
    }
    return;
  }

  const filename = CLIENT_FILES.get(url.pathname);
  if (!filename) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png"
  };
  const headers = {
    "Content-Type": contentTypes[extname(filename)],
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin"
  };
  if (filename === "service-worker.js") headers["Service-Worker-Allowed"] = "/";
  response.writeHead(200, {
    ...headers
  });
  createReadStream(join(ROOT_DIR, filename)).pipe(response);
});

const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 16_384 });

server.on("upgrade", (request, socket, head) => {
  const requestOrigin = request.headers.origin;
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const expectedOrigin = `${forwardedProtocol}://${request.headers.host}`;
  if (request.url !== "/ws" || (requestOrigin && requestOrigin !== expectedOrigin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit("connection", webSocket, request);
  });
});

webSocketServer.on("connection", (webSocket) => {
  let user;
  const authenticationTimeout = setTimeout(() => webSocket.close(4001, "Authentication required"), 5000);
  webSocket.on("message", async (rawMessage) => {
    let payload;
    try {
      payload = JSON.parse(rawMessage.toString());
    } catch {
      webSocket.send(JSON.stringify({ type: "error", error: "Некорректное сообщение." }));
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      webSocket.send(JSON.stringify({ type: "error", error: "Некорректное сообщение." }));
      return;
    }

    if (!user) {
      if (payload.type !== "auth" || typeof payload.token !== "string") {
        webSocket.close(4001, "Authentication required");
        return;
      }
      const userId = sessions.get(payload.token);
      user = userId ? findUser(userId) : undefined;
      if (!user) {
        webSocket.close(4001, "Session expired");
        return;
      }
      clearTimeout(authenticationTimeout);
      if (!connections.has(user.id)) connections.set(user.id, new Set());
      connections.get(user.id).add(webSocket);
      webSocket.send(JSON.stringify({
        type: "ready",
        online: user.contacts.filter((id) => connections.has(id))
      }));
      for (const contactId of user.contacts) sendToUser(contactId, { type: "presence", userId: user.id, online: true });
      return;
    }

    if (payload.type === "message") {
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      const recipient = findUser(payload.toId);
      if (!text || text.length > 4000 || !recipient || !isContact(user, recipient.id)) {
        webSocket.send(JSON.stringify({ type: "error", error: "Не удалось отправить сообщение." }));
        return;
      }
      const message = {
        id: randomUUID(),
        fromId: user.id,
        toId: recipient.id,
        text,
        createdAt: new Date().toISOString()
      };
      database.messages.push(message);
      saveDatabase();
      sendToUser(user.id, { type: "message", message });
      sendToUser(recipient.id, { type: "message", message });
      sendPushToUser(recipient.id, {
        title: `Сообщение от ${user.name}`,
        body: message.text.slice(0, 120),
        contactId: user.id,
        tag: `burunduk-${user.id}`
      });
      return;
    }

    if (payload.type === "typing") {
      if (isContact(user, payload.toId)) sendToUser(payload.toId, { type: "typing", fromId: user.id, active: Boolean(payload.active) });
      return;
    }

    if (payload.type === "signal") {
      const target = findUser(payload.toId);
      const signal = payload.signal;
      const validKind = signal && ["offer", "answer", "candidate", "hangup"].includes(signal.kind);
      if (!target || !isContact(user, target.id) || !validKind) {
        webSocket.send(JSON.stringify({ type: "error", error: "Сигнал звонка не прошёл проверку." }));
        return;
      }
      if (signal.kind === "offer") {
        const callType = signal.video ? "видеозвонок" : "аудиозвонок";
        sendPushToUser(target.id, {
          title: `Входящий ${callType}`,
          body: `${user.name} звонит вам. Откройте чат, чтобы перезвонить.`,
          contactId: user.id,
          type: "call",
          callType: signal.video ? "video" : "audio",
          tag: `burunduk-call-${user.id}-${randomUUID()}`
        });
      }
      sendToUser(target.id, { type: "signal", from: publicUser(user), signal });
    }
  });

  webSocket.on("close", () => {
    clearTimeout(authenticationTimeout);
    if (!user) return;
    const userSockets = connections.get(user.id);
    userSockets?.delete(webSocket);
    if (userSockets?.size === 0) {
      connections.delete(user.id);
      for (const contactId of user.contacts) sendToUser(contactId, { type: "presence", userId: user.id, online: false });
    }
  });
  webSocket.on("error", (error) => console.error("WebSocket error:", error.message));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Бурундук запущен: http://localhost:${PORT}`);
});
