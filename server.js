import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const scrypt = promisify(scryptCallback);
const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(ROOT_DIR, "data");
const DATA_FILE = join(DATA_DIR, "messenger.json");
const CLIENT_FILES = new Map([
  ["/", "Index.html"],
  ["/Index.html", "Index.html"],
  ["/style.css", "style.css"],
  ["/app.js", "app.js"]
]);

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

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

function isContact(user, otherId) {
  return user.contacts.includes(otherId);
}

function publicUser(user) {
  return { id: user.id, username: user.username, name: user.name, online: connections.has(user.id) };
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
      salt: salt.toString("hex"),
      passwordHash: passwordHash.toString("hex"),
      contacts: []
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
  const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  response.writeHead(200, {
    "Content-Type": contentTypes[extname(filename)],
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin"
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
