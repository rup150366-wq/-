const TOKEN_KEY = "burunduk-token";
const THEME_KEY = "burunduk-theme";
const ANIMAL_AVATARS = ["🐿️", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐸", "🐵", "🐰", "🦝", "🦉", "🦔", "🐹", "🐶", "🐱", "🐧", "🐤"];
const MESSAGE_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "👏"];
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const FILE_CHUNK_BYTES = 16 * 1024;
const MEDIA_STORE_NAME = "attachments";
const authScreen = document.querySelector("#auth-screen");
const appScreen = document.querySelector("#app-screen");
const authForm = document.querySelector("#auth-form");
const authError = document.querySelector("#auth-error");
const sidebarList = document.querySelector("#sidebar-list");
const searchInput = document.querySelector("#search-input");
const messagesArea = document.querySelector("#messages-area");
const messagesElement = document.querySelector("#messages");
const messageInput = document.querySelector("#message-input");
const fileInput = document.querySelector("#file-input");
const transferStatus = document.querySelector("#transfer-status");
const emptyConversation = document.querySelector("#empty-conversation");
const contactDialog = document.querySelector("#contact-dialog");
const callDialog = document.querySelector("#call-dialog");
const toast = document.querySelector("#toast");
const callToast = document.querySelector("#call-toast");
const profileDialog = document.querySelector("#profile-dialog");

let authMode = "login";
let currentUser = null;
let contacts = [];
let chats = [];
let currentContact = null;
let activeSection = "chats";
let socket = null;
let reconnectTimer = null;
let toastTimer = null;
let typingTimer = null;
let peerConnection = null;
let localStream = null;
let incomingCall = null;
let activeCallPeer = null;
let queuedCandidates = [];
let muted = false;
let cameraOff = false;
let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
let callTimer = null;
let callSoundTimer = null;
let callSoundTimeouts = [];
let audioContext = null;
let toastAction = null;
let pushNotificationsConfigured = false;
let pushSetupIssue = "";
let serviceWorkerReady = null;
let selectedAvatar = null;
let pendingReplyToId = null;
let currentMessagesById = new Map();
let mediaDatabasePromise = null;
const fileLinks = new Map();
const outgoingTransfers = new Map();
const incomingTransfers = new Map();
const mediaObjectUrls = new Set();
const initialUrl = new URLSearchParams(location.search);
let pendingNotificationContactId = initialUrl.get("contact");
let pendingMissedCallNotification = initialUrl.get("missedCall") === "1";
let notificationsEnabled = localStorage.getItem("burunduk-notifications") !== "false";
let soundEnabled = localStorage.getItem("burunduk-sound") !== "false";

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);
  if (!serviceWorkerReady) {
    serviceWorkerReady = navigator.serviceWorker.register("/service-worker.js?v=4", { scope: "/" })
      .then(() => navigator.serviceWorker.ready)
      .catch((error) => {
        console.warn("Не удалось зарегистрировать Service Worker:", error);
        serviceWorkerReady = null;
        return null;
      });
  }
  return serviceWorkerReady;
}

async function getServiceWorkerRegistration() {
  let timeoutId;
  try {
    const registration = await Promise.race([
      registerServiceWorker(),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          console.warn("Service Worker не активировался вовремя.");
          resolve(null);
        }, 10000);
      })
    ]);
    if (!registration) serviceWorkerReady = null;
    return registration;
  } finally {
    clearTimeout(timeoutId);
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "notification-click" && typeof event.data.contactId === "string") {
      openNotificationContact(event.data.contactId, event.data.notificationType);
    }
  });
}

const theme = localStorage.getItem(THEME_KEY) || "dark";
document.body.dataset.theme = theme;
updateThemeControls();

function updateThemeControls() {
  const label = document.querySelector("#theme-label");
  if (label) label.textContent = document.body.dataset.theme === "dark" ? "Тёмная тема" : "Тёплая тема";
  const icon = document.querySelector(".theme-icon");
  if (icon) icon.textContent = document.body.dataset.theme === "dark" ? "◐" : "☼";
}

function toggleTheme() {
  document.body.dataset.theme = document.body.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, document.body.dataset.theme);
  updateThemeControls();
}

document.querySelector("#theme-toggle").addEventListener("click", toggleTheme);
document.querySelector("#sidebar-theme-toggle").addEventListener("click", toggleTheme);

function showToast(message, action = null) {
  const targetToast = callDialog.open ? callToast : toast;
  const otherToast = targetToast === toast ? callToast : toast;
  otherToast.classList.remove("show", "actionable");
  toastAction = action;
  targetToast.textContent = message;
  targetToast.classList.toggle("actionable", Boolean(action));
  targetToast.tabIndex = action ? 0 : -1;
  targetToast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    targetToast.classList.remove("show", "actionable");
    toastAction = null;
  }, 7000);
}

function getMediaDatabase() {
  if (!("indexedDB" in window)) return Promise.reject(new Error("Браузер не поддерживает локальное хранилище файлов."));
  if (!mediaDatabasePromise) {
    mediaDatabasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open("burunduk-media", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(MEDIA_STORE_NAME)) {
          request.result.createObjectStore(MEDIA_STORE_NAME, { keyPath: "messageId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        mediaDatabasePromise = null;
        reject(request.error || new Error("Не удалось открыть хранилище файлов."));
      };
      request.onblocked = () => {
        mediaDatabasePromise = null;
        reject(new Error("Закройте другие вкладки Бурундука и повторите попытку."));
      };
    });
  }
  return mediaDatabasePromise;
}

async function storeMediaAttachment(messageId, blob) {
  const database = await getMediaDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(MEDIA_STORE_NAME, "readwrite");
    transaction.objectStore(MEDIA_STORE_NAME).put({ messageId, blob });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Не удалось сохранить файл на устройстве."));
    transaction.onabort = () => reject(transaction.error || new Error("Сохранение файла было прервано."));
  });
}

async function loadMediaAttachment(messageId) {
  const database = await getMediaDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(MEDIA_STORE_NAME, "readonly")
      .objectStore(MEDIA_STORE_NAME)
      .get(messageId);
    request.onsuccess = () => resolve(request.result?.blob || null);
    request.onerror = () => reject(request.error || new Error("Не удалось прочитать файл с устройства."));
  });
}

async function removeMediaAttachment(messageId) {
  const database = await getMediaDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(MEDIA_STORE_NAME, "readwrite");
    transaction.objectStore(MEDIA_STORE_NAME).delete(messageId);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("Не удалось удалить временный файл."));
  });
}

function updateTransferStatus(text) {
  transferStatus.textContent = text;
  transferStatus.classList.remove("hidden");
}

function showNotification(title, body, contactId, serverPushWillNotify = false) {
  if (!notificationsEnabled) return;
  const contact = contactById(contactId);
  showToast(`${title}: ${body}`, () => contact && focusContact(contact));

  void showSystemNotification(title, body, contactId, serverPushWillNotify);
}

async function showSystemNotification(title, body, contactId, serverPushWillNotify) {
  if (!document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
  if (serverPushWillNotify && pushNotificationsConfigured) return;
  const options = {
    body,
    tag: `burunduk-${contactId}`,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    vibrate: [180, 80, 180],
    data: { contactId }
  };
  try {
    const registration = await getServiceWorkerRegistration();
    if (registration) {
      await registration.showNotification(title, options);
      return;
    }
    const notification = new Notification(title, options);
    notification.onclick = () => {
      notification.close();
      window.focus();
      const contact = contactById(contactId);
      if (contact) focusContact(contact);
    };
  } catch (error) {
    console.warn("Системное уведомление недоступно:", error);
  }
}

function decodeApplicationServerKey(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const raw = atob(padded);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function syncPushSubscription() {
  if (!notificationsEnabled || !currentUser) return false;
  if (!window.isSecureContext) {
    pushSetupIssue = "Для push на телефоне нужен HTTPS.";
    return false;
  }
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
    pushSetupIssue = "Этот браузер не поддерживает Web Push.";
    return false;
  }
  if (Notification.permission !== "granted") {
    pushSetupIssue = "Разрешите уведомления для сайта в настройках браузера.";
    return false;
  }
  try {
    const registration = await getServiceWorkerRegistration();
    if (!registration) {
      pushSetupIssue = "Service Worker не запустился. Удалите старую регистрацию сайта в настройках браузера и обновите страницу.";
      return false;
    }
    const { publicKey } = await api("/api/push/public-key");
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeApplicationServerKey(publicKey)
      });
    }
    await api("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ subscription: subscription.toJSON() })
    });
    pushSetupIssue = "";
    pushNotificationsConfigured = true;
    return true;
  } catch (error) {
    pushNotificationsConfigured = false;
    pushSetupIssue = "Не удалось создать push-подписку. Проверьте подключение и попробуйте снова.";
    console.warn("Не удалось включить push-уведомления:", error);
    return false;
  }
}

async function enableSystemNotifications() {
  if (!window.isSecureContext) {
    showToast("Push на телефоне работает только по HTTPS. На этом устройстве можно использовать localhost.");
    return;
  }
  if (!("Notification" in window)) {
    showToast("Всплывающие уведомления включены. Системные уведомления браузер не поддерживает.");
    return;
  }
  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch (error) {
      console.warn("Не удалось запросить разрешение на уведомления:", error);
      showToast("Всплывающие уведомления приложения включены");
      return;
    }
  }
  updateNotificationControls();
  if (permission !== "granted") {
    pushSetupIssue = "Браузер заблокировал уведомления.";
    showToast("Push заблокирован браузером. Откройте настройки сайта рядом с адресной строкой → «Уведомления» → «Разрешить», затем включите уведомления здесь.");
    return;
  }
  const pushEnabled = await syncPushSubscription();
  showToast(pushEnabled
    ? "Системные уведомления включены, в том числе в фоне"
    : `Всплывающие уведомления работают. ${pushSetupIssue || "Проверьте поддержку push в браузере."}`);
}

async function removePushSubscription(token = localStorage.getItem(TOKEN_KEY)) {
  pushNotificationsConfigured = false;
  try {
    const registration = await getServiceWorkerRegistration();
    const subscription = await registration?.pushManager?.getSubscription();
    if (!subscription) return;
    await subscription.unsubscribe();
    if (token) {
      await api("/api/push/subscribe", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ endpoint: subscription.endpoint })
      });
    }
  } catch (error) {
    console.warn("Не удалось отключить push-уведомления:", error);
  }
}

function openNotificationContact(contactId, notificationType = "message") {
  const contact = contactById(contactId);
  if (contact) {
    pendingNotificationContactId = null;
    focusContact(contact);
    if (notificationType === "call" && !incomingCall) {
      showToast("Звонок мог завершиться. Вы можете перезвонить из чата.");
    }
    return;
  }
  pendingNotificationContactId = contactId;
  pendingMissedCallNotification = notificationType === "call";
}

function focusContact(contact) {
  activeSection = "chats";
  searchInput.value = "";
  renderSidebar();
  selectContact(contact);
}

function updateSoundControls() {
  const button = document.querySelector("#sound-toggle");
  button.classList.toggle("is-on", soundEnabled);
  button.setAttribute("aria-pressed", String(soundEnabled));
  button.querySelector("span:last-child").textContent = soundEnabled ? "Звук вкл." : "Звук выкл.";
}

function updateNotificationControls() {
  const button = document.querySelector("#notification-toggle");
  button.classList.toggle("is-on", notificationsEnabled);
  button.setAttribute("aria-pressed", String(notificationsEnabled));
  button.querySelector("span:last-child").textContent = notificationsEnabled ? "Уведомления" : "Без уведомлений";
  button.title = !notificationsEnabled
    ? "Включить уведомления"
    : !("Notification" in window) || Notification.permission === "denied"
      ? "Push заблокирован браузером: разрешите уведомления в настройках сайта"
      : Notification.permission === "default"
        ? "Нажмите, чтобы настроить системные уведомления"
        : pushNotificationsConfigured
          ? "Системные уведомления включены"
          : "Разрешение есть, но push не подключён — нажмите, чтобы повторить настройку";
}

function unlockSound() {
  if (!soundEnabled) return;
  const AudioContextType = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextType) return;
  try {
    if (!audioContext) audioContext = new AudioContextType();
    if (audioContext.state === "suspended") audioContext.resume().catch((error) => console.warn("Звук недоступен:", error));
  } catch (error) {
    console.warn("Не удалось включить звук:", error);
  }
}

function playTone(frequency, duration = 0.13, volume = 0.18) {
  if (!soundEnabled) return;
  unlockSound();
  if (!audioContext || audioContext.state === "closed") return;
  if (audioContext.state === "suspended") {
    audioContext.resume()
      .then(() => scheduleTone(frequency, duration, volume))
      .catch((error) => console.warn("Звук недоступен:", error));
    return;
  }
  scheduleTone(frequency, duration, volume);
}

function scheduleTone(frequency, duration, volume) {
  if (!audioContext || audioContext.state !== "running") return;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  const now = audioContext.currentTime;
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, now);
  gain.gain.setValueAtTime(0.001, now);
  gain.gain.exponentialRampToValueAtTime(volume, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
  oscillator.connect(gain);
  gain.connect(audioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + duration);
}

function playMessageSound() {
  playTone(680, 0.12, 0.2);
  setTimeout(() => playTone(880, 0.14, 0.2), 110);
}

function startCallSound() {
  stopCallSound();
  if (!soundEnabled) return;
  const ring = () => {
    playTone(560, 0.3, 0.18);
    callSoundTimeouts.push(setTimeout(() => playTone(740, 0.3, 0.18), 360));
  };
  ring();
  callSoundTimer = setInterval(ring, 1900);
}

function stopCallSound() {
  clearInterval(callSoundTimer);
  callSoundTimer = null;
  callSoundTimeouts.forEach(clearTimeout);
  callSoundTimeouts = [];
}

document.querySelector("#toast").addEventListener("click", () => {
  const action = toastAction;
  toastAction = null;
  callToast.classList.remove("show", "actionable");
  toast.tabIndex = -1;
  toast.classList.remove("actionable");
  if (action) action();
});
callToast.addEventListener("click", () => {
  const action = toastAction;
  toastAction = null;
  toast.classList.remove("show", "actionable");
  callToast.tabIndex = -1;
  callToast.classList.remove("actionable");
  if (action) action();
});
document.addEventListener("pointerdown", unlockSound, { once: true });

document.querySelector("#sound-toggle").addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  localStorage.setItem("burunduk-sound", String(soundEnabled));
  updateSoundControls();
  if (soundEnabled) {
    unlockSound();
    playTone(760, 0.12);
  } else {
    stopCallSound();
  }
});

document.querySelector("#notification-toggle").addEventListener("click", async () => {
  const hasSavedPreference = localStorage.getItem("burunduk-notifications") !== null;
  if (!hasSavedPreference && notificationsEnabled) {
    localStorage.setItem("burunduk-notifications", "true");
    updateNotificationControls();
    await enableSystemNotifications();
    return;
  }

  notificationsEnabled = !notificationsEnabled;
  localStorage.setItem("burunduk-notifications", String(notificationsEnabled));
  updateNotificationControls();
  if (!notificationsEnabled) {
    void removePushSubscription();
    showToast("Уведомления выключены");
    return;
  }
  await enableSystemNotifications();
});

updateSoundControls();
updateNotificationControls();

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(localStorage.getItem(TOKEN_KEY) ? { Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY)}` } : {}),
        ...options.headers
      }
    });
  } catch {
    throw new Error("Не удалось подключиться к серверу. Запустите Бурундук командой npm start.");
  }
  const body = await response.text();
  let result;
  try {
    result = body ? JSON.parse(body) : {};
  } catch {
    const detail = body.trim() || "пустой ответ";
    throw new Error(`Сервер вернул не JSON (HTTP ${response.status}): ${detail}`);
  }
  if (!response.ok) throw new Error(result.error || "Запрос не выполнен.");
  return result;
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  document.querySelector("#login-tab").classList.toggle("active", !registering);
  document.querySelector("#register-tab").classList.toggle("active", registering);
  document.querySelector("#login-tab").setAttribute("aria-selected", String(!registering));
  document.querySelector("#register-tab").setAttribute("aria-selected", String(registering));
  document.querySelector("#name-field").hidden = !registering;
  document.querySelector("#auth-name").required = registering;
  document.querySelector("#auth-password").autocomplete = registering ? "new-password" : "current-password";
  document.querySelector("#auth-submit").innerHTML = registering ? "Создать аккаунт <span>→</span>" : "Войти <span>→</span>";
  authError.hidden = true;
  authError.textContent = "";
}

document.querySelector("#login-tab").addEventListener("click", () => setAuthMode("login"));
document.querySelector("#register-tab").addEventListener("click", () => setAuthMode("register"));

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authError.hidden = true;
  const payload = {
    username: document.querySelector("#auth-username").value.trim(),
    password: document.querySelector("#auth-password").value
  };
  if (authMode === "register") payload.name = document.querySelector("#auth-name").value.trim();
  try {
    const result = await api(`/api/${authMode === "register" ? "register" : "login"}`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    localStorage.setItem(TOKEN_KEY, result.token);
    currentUser = result.user;
    await enterMessenger();
    authForm.reset();
  } catch (error) {
    authError.textContent = error.message;
    authError.hidden = false;
  }
});

async function enterMessenger() {
  if (!currentUser) {
    const result = await api("/api/me");
    currentUser = result.user;
  }
  authScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
  updateProfilePresentation();
  await Promise.all([loadContacts(), loadChats()]);
  if (pendingNotificationContactId) {
    const contact = contactById(pendingNotificationContactId);
    if (contact) {
      pendingNotificationContactId = null;
      const missedCallNotification = pendingMissedCallNotification;
      pendingMissedCallNotification = false;
      history.replaceState(null, "", location.pathname);
      await selectContact(contact);
      if (missedCallNotification) showToast("Звонок пропущен. Вы можете перезвонить из чата.");
    }
  }
  if (notificationsEnabled && "Notification" in window && Notification.permission === "granted") {
    await syncPushSubscription();
    updateNotificationControls();
  }
  try {
    const config = await api("/api/rtc-config");
    iceServers = config.iceServers;
  } catch (error) {
    showToast(error.message);
  }
  connectWebSocket();
}

async function loadContacts() {
  const result = await api("/api/contacts");
  contacts = result.contacts;
  if (currentContact) {
    const refreshedContact = contactById(currentContact.id);
    if (refreshedContact) {
      currentContact = refreshedContact;
      updateContactHeader(currentContact);
      document.querySelectorAll(".message-avatar").forEach((avatar) => setAvatarElement(avatar, currentContact));
    }
  }
  renderSidebar();
}

async function loadChats() {
  const result = await api("/api/chats");
  chats = result.chats;
  renderSidebar();
}

function nameInitial(name) {
  return name.trim().charAt(0).toLocaleUpperCase("ru") || "?";
}

function setAvatarElement(element, user) {
  const hasAnimalAvatar = ANIMAL_AVATARS.includes(user.avatar);
  element.textContent = hasAnimalAvatar ? user.avatar : nameInitial(user.name);
  element.classList.toggle("emoji-avatar", hasAnimalAvatar);
}

function updateProfilePresentation() {
  if (!currentUser) return;
  document.querySelector("#profile-name").textContent = currentUser.name;
  document.querySelector("#profile-username").textContent = `@${currentUser.username}`;
  setAvatarElement(document.querySelector("#profile-avatar"), currentUser);
}

function contactById(id) {
  return contacts.find((contact) => contact.id === id);
}

function emptyList(title, description, actionText = "") {
  const empty = document.createElement("div");
  empty.className = "list-empty";
  const titleElement = document.createElement("div");
  titleElement.textContent = title;
  empty.append(titleElement);
  if (description) {
    const descriptionElement = document.createElement("div");
    descriptionElement.textContent = description;
    empty.append(descriptionElement);
  }
  if (actionText) {
    const action = document.createElement("button");
    action.className = "primary-button";
    action.type = "button";
    action.textContent = actionText;
    action.addEventListener("click", openContactDialog);
    empty.append(action);
  }
  return empty;
}

function renderSidebar() {
  sidebarList.replaceChildren();
  const query = searchInput.value.trim().toLocaleLowerCase("ru");
  const source = activeSection === "chats" ? chats : contacts;
  const visible = source.filter((entry) =>
    `${entry.name} ${entry.username}`.toLocaleLowerCase("ru").includes(query)
  );
  document.querySelector("#chats-tab").classList.toggle("active", activeSection === "chats");
  document.querySelector("#contacts-tab").classList.toggle("active", activeSection === "contacts");
  document.querySelector("#chats-tab").setAttribute("aria-selected", String(activeSection === "chats"));
  document.querySelector("#contacts-tab").setAttribute("aria-selected", String(activeSection === "contacts"));
  document.querySelector("#list-heading-title").textContent = activeSection === "chats" ? "Переписки" : "Ваши контакты";
  searchInput.placeholder = activeSection === "chats" ? "Поиск по чатам" : "Поиск по контактам";

  if (!visible.length) {
    sidebarList.append(activeSection === "contacts"
      ? emptyList(query ? "Никого не нашли" : "Контактов пока нет", "Добавьте человека по его никнейму.", "Добавить контакт")
      : emptyList(query ? "Переписок не найдено" : "Новых переписок пока нет", "Откройте контакты и напишите первым."));
    return;
  }

  for (const entry of visible) {
    const item = document.createElement("button");
    item.className = `sidebar-item${currentContact?.id === entry.id ? " active" : ""}`;
    item.type = "button";
    item.dataset.userId = entry.id;

    const avatar = document.createElement("span");
    avatar.className = `avatar${entry.online ? " online" : ""}`;
    setAvatarElement(avatar, entry);

    const copy = document.createElement("span");
    copy.className = "sidebar-item-copy";
    const top = document.createElement("span");
    top.className = "sidebar-item-top";
    const name = document.createElement("strong");
    name.textContent = entry.name;
    const right = document.createElement("time");
    if (activeSection === "chats" && entry.lastMessage) right.textContent = formatTime(entry.lastMessage.createdAt);
    else right.textContent = entry.online ? "в сети" : "";
    if (entry.online) right.classList.add("online-label");
    top.append(name, right);

    const bottom = document.createElement("span");
    bottom.className = "sidebar-item-bottom";
    const preview = document.createElement("span");
    preview.textContent = activeSection === "chats"
      ? (entry.lastMessage?.type === "attachment"
        ? `📎 ${entry.lastMessage.attachment.name}`
        : (entry.lastMessage?.text || ""))
      : `@${entry.username}`;
    bottom.append(preview);
    copy.append(top, bottom);
    item.append(avatar, copy);
    sidebarList.append(item);
  }
}

function formatTime(value) {
  const date = new Date(value);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function formatMessageTime(value) {
  return new Date(value).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function renderMessages(items) {
  for (const objectUrl of mediaObjectUrls) URL.revokeObjectURL(objectUrl);
  mediaObjectUrls.clear();
  messagesElement.replaceChildren();
  const messagesById = new Map(items.map((message) => [message.id, message]));
  currentMessagesById = messagesById;
  for (const message of items) {
    const own = message.fromId === currentUser.id;
    const row = document.createElement("div");
    row.className = `message-row${own ? " own" : ""}`;
    row.dataset.messageId = message.id;
    if (!own) {
      const avatar = document.createElement("span");
      avatar.className = "message-avatar avatar";
      setAvatarElement(avatar, currentContact);
      row.append(avatar);
    }

    const wrap = document.createElement("div");
    wrap.className = "bubble-wrap";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    if (message.replyToId) {
      const repliedTo = messagesById.get(message.replyToId);
      const quote = document.createElement("div");
      quote.className = "reply-quote";
      const quoteAuthor = document.createElement("strong");
      quoteAuthor.textContent = repliedTo
        ? (repliedTo.fromId === currentUser.id ? "Вы" : currentContact.name)
        : "Ответ";
      const quoteText = document.createElement("span");
      quoteText.textContent = repliedTo
        ? (repliedTo.type === "attachment" ? `📎 ${repliedTo.attachment.name}` : repliedTo.text)
        : "Сообщение недоступно";
      quote.append(quoteAuthor, quoteText);
      bubble.append(quote);
    }
    if (message.type === "attachment" && message.attachment) {
      renderAttachmentMessage(message, bubble);
    } else {
      const text = document.createElement("span");
      text.className = "message-text";
      text.textContent = message.text;
      bubble.append(text);
    }
    const reactions = document.createElement("div");
    reactions.className = "message-reactions";
    for (const [emoji, users] of Object.entries(message.reactions || {})) {
      if (!Array.isArray(users) || users.length === 0) continue;
      const chip = document.createElement("button");
      chip.className = "reaction-chip";
      chip.type = "button";
      chip.dataset.messageAction = "reaction";
      chip.dataset.messageId = message.id;
      chip.dataset.emoji = emoji;
      chip.setAttribute("aria-pressed", String(users.includes(currentUser.id)));
      chip.textContent = `${emoji} ${users.length}`;
      reactions.append(chip);
    }
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = formatMessageTime(message.createdAt);
    const actions = document.createElement("div");
    actions.className = "message-actions";
    const replyButton = document.createElement("button");
    replyButton.className = "message-action";
    replyButton.type = "button";
    replyButton.dataset.messageAction = "reply";
    replyButton.dataset.messageId = message.id;
    replyButton.setAttribute("aria-label", "Ответить на сообщение");
    replyButton.title = "Ответить";
    replyButton.textContent = "↩";
    const reactionsWrap = document.createElement("div");
    reactionsWrap.className = "reaction-menu-wrap";
    const reactionsButton = document.createElement("button");
    reactionsButton.className = "message-action";
    reactionsButton.type = "button";
    reactionsButton.dataset.messageAction = "toggle-reactions";
    reactionsButton.setAttribute("aria-label", "Выбрать реакцию");
    reactionsButton.setAttribute("aria-expanded", "false");
    reactionsButton.title = "Реакция";
    reactionsButton.textContent = "☺";
    const picker = document.createElement("div");
    picker.className = "reaction-picker hidden";
    picker.setAttribute("aria-label", "Выберите реакцию");
    for (const emoji of MESSAGE_REACTIONS) {
      const emojiButton = document.createElement("button");
      emojiButton.type = "button";
      emojiButton.dataset.messageAction = "reaction";
      emojiButton.dataset.messageId = message.id;
      emojiButton.dataset.emoji = emoji;
      emojiButton.setAttribute("aria-label", emoji);
      emojiButton.textContent = emoji;
      picker.append(emojiButton);
    }
    reactionsWrap.append(reactionsButton, picker);
    actions.append(replyButton, reactionsWrap);
    wrap.append(bubble);
    if (reactions.childElementCount > 0) wrap.append(reactions);
    wrap.append(actions, meta);
    row.append(wrap);
    messagesElement.append(row);
  }
  messagesArea.scrollTop = messagesArea.scrollHeight;
}

function formatFileSize(size) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} КБ`;
  return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
}

function renderAttachmentMessage(message, bubble) {
  const attachment = message.attachment;
  const card = document.createElement("div");
  card.className = "attachment-card";
  const name = document.createElement("strong");
  name.className = "attachment-name";
  name.textContent = attachment.name;
  const details = document.createElement("span");
  details.className = "attachment-details";
  details.textContent = `${attachment.mimeType.startsWith("video/") ? "Видео" : "Изображение"} · ${formatFileSize(attachment.size)}`;
  const status = document.createElement("span");
  status.className = "attachment-status";
  status.textContent = "Проверяем файл на устройстве...";
  card.append(name, details, status);
  bubble.append(card);

  void loadMediaAttachment(message.id).then((blob) => {
    if (!bubble.isConnected) return;
    if (!blob) {
      status.textContent = "Файл недоступен на этом устройстве";
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    mediaObjectUrls.add(objectUrl);
    status.remove();
    if (attachment.mimeType.startsWith("image/")) {
      const image = document.createElement("img");
      image.className = "attachment-preview";
      image.src = objectUrl;
      image.alt = attachment.name;
      image.loading = "lazy";
      card.insertBefore(image, name);
    } else if (attachment.mimeType.startsWith("video/")) {
      const video = document.createElement("video");
      video.className = "attachment-preview";
      video.src = objectUrl;
      video.controls = true;
      video.playsInline = true;
      card.insertBefore(video, name);
    }
    const download = document.createElement("a");
    download.className = "attachment-download";
    download.href = objectUrl;
    download.download = attachment.name;
    download.textContent = "Открыть или скачать";
    card.append(download);
  }).catch((error) => {
    if (!bubble.isConnected) return;
    console.error("Не удалось открыть локальное вложение:", error);
    status.textContent = "Не удалось прочитать файл с устройства";
  });
}

function clearPendingReply() {
  pendingReplyToId = null;
  document.querySelector("#reply-preview").classList.add("hidden");
}

function prepareReply(message) {
  pendingReplyToId = message.id;
  document.querySelector("#reply-sender").textContent = message.fromId === currentUser.id ? "Вы отвечаете себе" : `Ответ ${currentContact.name}`;
  document.querySelector("#reply-text").textContent = message.type === "attachment"
    ? `📎 ${message.attachment.name}`
    : message.text;
  document.querySelector("#reply-preview").classList.remove("hidden");
  messageInput.focus();
}

function sendMessageReaction(messageId, emoji) {
  if (!currentContact || !socket || socket.readyState !== WebSocket.OPEN) {
    showToast("Нет соединения с сервером");
    return;
  }
  socket.send(JSON.stringify({
    type: "reaction",
    toId: currentContact.id,
    messageId,
    emoji
  }));
}

messagesElement.addEventListener("click", (event) => {
  const button = event.target.closest("[data-message-action]");
  if (!button) return;
  const action = button.dataset.messageAction;
  const row = button.closest(".message-row");
  if (!row) return;
  const messageId = button.dataset.messageId || row.dataset.messageId;
  if (action === "reply") {
    const message = row.dataset.messageId;
    const target = message && currentMessagesById.get(message);
    if (target) prepareReply(target);
    return;
  }
  if (action === "toggle-reactions") {
    const picker = button.parentElement.querySelector(".reaction-picker");
    const willOpen = picker.classList.contains("hidden");
    picker.classList.toggle("hidden", !willOpen);
    button.setAttribute("aria-expanded", String(willOpen));
    return;
  }
  if (action === "reaction") {
    sendMessageReaction(messageId, button.dataset.emoji);
    const picker = button.closest(".reaction-picker");
    if (picker) picker.classList.add("hidden");
    const trigger = button.closest(".reaction-menu-wrap")?.querySelector("[data-message-action='toggle-reactions']");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  }
});

document.querySelector("#cancel-reply").addEventListener("click", clearPendingReply);

async function selectContact(contact) {
  if (!contact) return;
  clearPendingReply();
  transferStatus.classList.add("hidden");
  currentContact = contact;
  updateContactHeader(contact);
  document.querySelector("#audio-call-button").disabled = false;
  document.querySelector("#video-call-button").disabled = false;
  emptyConversation.classList.add("hidden");
  messagesArea.classList.remove("hidden");
  document.querySelector("#message-form").classList.remove("hidden");
  document.querySelector("#composer-hint").classList.remove("hidden");
  document.querySelector("#message-input").focus();
  document.querySelector("#sidebar").classList.add("has-chat");
  appScreen.classList.add("chat-open");
  renderSidebar();
  try {
    const result = await api(`/api/messages?with=${encodeURIComponent(contact.id)}`);
    if (currentContact?.id === contact.id) renderMessages(result.messages);
  } catch (error) {
    showToast(error.message);
  }
}

function updateContactHeader(contact) {
  document.querySelector("#chat-name").textContent = contact.name;
  const status = document.querySelector("#chat-status");
  status.textContent = contact.online ? "в сети" : `@${contact.username}`;
  status.classList.toggle("online-label", Boolean(contact.online));
  setAvatarElement(document.querySelector("#header-avatar"), contact);
}

sidebarList.addEventListener("click", (event) => {
  const item = event.target.closest("[data-user-id]");
  if (item) selectContact(contactById(item.dataset.userId));
});

document.querySelector("#chats-tab").addEventListener("click", () => switchSection("chats"));
document.querySelector("#contacts-tab").addEventListener("click", () => switchSection("contacts"));
searchInput.addEventListener("input", renderSidebar);

function switchSection(section) {
  activeSection = section;
  searchInput.value = "";
  renderSidebar();
  if (window.matchMedia("(max-width: 560px)").matches) appScreen.classList.remove("chat-open");
}

document.querySelector("#add-contact-button").addEventListener("click", openContactDialog);
document.querySelector("#empty-add-contact").addEventListener("click", openContactDialog);

function openContactDialog() {
  document.querySelector("#contact-error").hidden = true;
  document.querySelector("#contact-form").reset();
  contactDialog.showModal();
  document.querySelector("#contact-username").focus();
}

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => document.querySelector(`#${button.dataset.closeDialog}`).close());
});

function updateAvatarPicker() {
  document.querySelectorAll(".animal-avatar-choice").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.avatar === selectedAvatar));
  });
  document.querySelector("#profile-dialog-avatar").textContent = selectedAvatar;
}

function openProfileDialog() {
  if (!currentUser) return;
  selectedAvatar = ANIMAL_AVATARS.includes(currentUser.avatar) ? currentUser.avatar : ANIMAL_AVATARS[0];
  document.querySelector("#profile-dialog-name").textContent = currentUser.name;
  document.querySelector("#profile-dialog-username").textContent = `@${currentUser.username}`;
  const picker = document.querySelector("#animal-avatar-picker");
  picker.replaceChildren(...ANIMAL_AVATARS.map((avatar) => {
    const option = document.createElement("button");
    option.className = "animal-avatar-choice";
    option.type = "button";
    option.dataset.avatar = avatar;
    option.setAttribute("aria-label", `Аватар ${avatar}`);
    option.textContent = avatar;
    option.addEventListener("click", () => {
      selectedAvatar = avatar;
      updateAvatarPicker();
    });
    return option;
  }));
  document.querySelector("#profile-error").hidden = true;
  updateAvatarPicker();
  profileDialog.showModal();
}

document.querySelector("#profile-open-button").addEventListener("click", openProfileDialog);
profileDialog.addEventListener("click", (event) => {
  if (event.target === profileDialog) profileDialog.close();
});
document.querySelector("#profile-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorElement = document.querySelector("#profile-error");
  const saveButton = document.querySelector("#profile-save-button");
  errorElement.hidden = true;
  saveButton.disabled = true;
  try {
    const result = await api("/api/profile", {
      method: "PATCH",
      body: JSON.stringify({ avatar: selectedAvatar })
    });
    currentUser = result.user;
    updateProfilePresentation();
    profileDialog.close();
    try {
      await Promise.all([loadContacts(), loadChats()]);
    } catch (error) {
      showToast(`Аватар сохранён, но список контактов не обновился: ${error.message}`);
      return;
    }
    showToast("Аватар профиля обновлён");
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  } finally {
    saveButton.disabled = false;
  }
});

contactDialog.addEventListener("click", (event) => {
  if (event.target === contactDialog) contactDialog.close();
});

document.querySelector("#contact-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const errorElement = document.querySelector("#contact-error");
  errorElement.hidden = true;
  const username = document.querySelector("#contact-username").value.trim();
  try {
    const result = await api("/api/contacts", { method: "POST", body: JSON.stringify({ username }) });
    contactDialog.close();
    await Promise.all([loadContacts(), loadChats()]);
    activeSection = "contacts";
    searchInput.value = "";
    renderSidebar();
    await selectContact(result.contact);
    showToast(`${result.contact.name} добавлен(а) в контакты`);
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
  }
});

document.querySelector("#message-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text || !currentContact) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    showToast("Нет соединения с сервером");
    return;
  }
  socket.send(JSON.stringify({
    type: "message",
    toId: currentContact.id,
    text,
    replyToId: pendingReplyToId
  }));
  messageInput.value = "";
  messageInput.style.height = "auto";
  clearPendingReply();
  sendTyping(false);
  messageInput.focus();
});

document.querySelector(".emoji-button").addEventListener("click", () => {
  messageInput.value += " 🙂";
  messageInput.dispatchEvent(new Event("input", { bubbles: true }));
  messageInput.focus();
});

document.querySelector("#file-button").addEventListener("click", () => {
  if (!currentContact) {
    showToast("Сначала выберите контакт");
    return;
  }
  if (!currentContact.online) {
    showToast("Фото и видео можно отправить, когда собеседник в сети.");
    return;
  }
  fileInput.click();
});

fileInput.addEventListener("change", () => {
  const files = Array.from(fileInput.files || []);
  fileInput.value = "";
  if (files.length > 0) void sendMediaFiles(files);
});

function sendTyping(active) {
  if (socket?.readyState === WebSocket.OPEN && currentContact) {
    socket.send(JSON.stringify({ type: "typing", toId: currentContact.id, active }));
  }
}

function sendFileSignal(toId, signal) {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Нет соединения с сервером.");
  socket.send(JSON.stringify({ type: "file-signal", toId, signal }));
}

function settleFileLink(link, error = null) {
  if (link.readySettled) return;
  link.readySettled = true;
  link.resolveReady(error ? { error } : { channel: link.channel });
}

function failFileLink(link, error) {
  if (link.failed) return;
  link.failed = true;
  if (fileLinks.get(link.peerId) === link) fileLinks.delete(link.peerId);
  settleFileLink(link, error);
  for (const [transferId, transfer] of outgoingTransfers) {
    if (transfer.peerId !== link.peerId) continue;
    clearTimeout(transfer.timeout);
    transfer.reject(error);
    outgoingTransfers.delete(transferId);
  }
  for (const [transferId, transfer] of incomingTransfers) {
    if (transfer.peerId === link.peerId) incomingTransfers.delete(transferId);
  }
  if (link.pc.connectionState !== "closed") link.pc.close();
}

function attachFileChannel(link, channel) {
  link.channel = channel;
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = 128 * 1024;
  channel.addEventListener("open", () => settleFileLink(link));
  channel.addEventListener("message", (event) => {
    void handleFileDataMessage(link, event).catch((error) => {
      console.error("Ошибка передачи P2P-файла:", error);
      updateTransferStatus("Не удалось принять файл.");
      let transferId = "";
      if (typeof event.data === "string") {
        try {
          transferId = JSON.parse(event.data).transferId || "";
        } catch {
          transferId = "";
        }
      } else if (event.data instanceof ArrayBuffer && event.data.byteLength >= 36) {
        transferId = new TextDecoder().decode(new Uint8Array(event.data).subarray(0, 36));
      }
      if (transferId) incomingTransfers.delete(transferId);
      if (channel.readyState === "open") {
        channel.send(JSON.stringify({
          kind: "error",
          transferId,
          error: "Не удалось сохранить файл на устройстве."
        }));
      }
    });
  });
  channel.addEventListener("close", () => {
    if (fileLinks.get(link.peerId) === link) fileLinks.delete(link.peerId);
    failFileLink(link, new Error("P2P-соединение передачи файла закрыто."));
  });
  channel.addEventListener("error", () => failFileLink(link, new Error("Ошибка P2P-канала передачи файла.")));
  if (channel.readyState === "open") settleFileLink(link);
}

function createFileLink(peerId, isOfferer) {
  const connection = new RTCPeerConnection({ iceServers });
  let resolveReady;
  const link = {
    peerId,
    pc: connection,
    channel: null,
    isOfferer,
    requestSent: false,
    pendingCandidates: [],
    readyPromise: new Promise((resolve) => { resolveReady = resolve; }),
    resolveReady,
    readySettled: false
  };
  fileLinks.set(peerId, link);
  connection.onicecandidate = (event) => {
    if (!event.candidate) return;
    try {
      sendFileSignal(peerId, { kind: "candidate", candidate: event.candidate });
    } catch (error) {
      failFileLink(link, error);
    }
  };
  connection.ondatachannel = (event) => attachFileChannel(link, event.channel);
  connection.onconnectionstatechange = () => {
    if (connection.connectionState === "failed" || connection.connectionState === "closed") {
      failFileLink(link, new Error("Не удалось установить прямое соединение. Возможно, потребуется TURN."));
    }
  };
  if (isOfferer) {
    attachFileChannel(link, connection.createDataChannel("burunduk-media", { ordered: true }));
    void (async () => {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      sendFileSignal(peerId, { kind: "offer", description: connection.localDescription });
    })().catch((error) => failFileLink(link, error));
  }
  return link;
}

function waitForFileChannel(link) {
  let timeoutId;
  return Promise.race([
    link.readyPromise,
    new Promise((resolve) => {
      timeoutId = setTimeout(() => resolve({
        error: new Error("Не удалось соединиться напрямую. Проверьте сеть и настройку TURN.")
      }), 25_000);
    })
  ]).then((result) => {
    clearTimeout(timeoutId);
    if (result.error) throw result.error;
    return result.channel;
  });
}

async function ensureFileChannel(peerId) {
  if (typeof RTCPeerConnection === "undefined") throw new Error("Этот браузер не поддерживает P2P-передачу файлов.");
  let link = fileLinks.get(peerId);
  if (
    link &&
    (link.pc.connectionState === "failed" ||
      link.pc.connectionState === "closed" ||
      link.channel?.readyState === "closed")
  ) {
    link.pc.close();
    fileLinks.delete(peerId);
    link = null;
  }
  if (!link) {
    const isOfferer = currentUser.id.localeCompare(peerId) < 0;
    link = createFileLink(peerId, isOfferer);
  }
  if (!link.isOfferer && !link.requestSent) {
    sendFileSignal(peerId, { kind: "request" });
    link.requestSent = true;
  }
  try {
    return await waitForFileChannel(link);
  } catch (error) {
    if (fileLinks.get(peerId) === link) {
      fileLinks.delete(peerId);
      link.pc.close();
    }
    throw error;
  }
}

async function waitForFileBuffer(channel) {
  if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) return;
  await new Promise((resolve, reject) => {
    const onLow = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("P2P-соединение прервано."));
    };
    const cleanup = () => {
      channel.removeEventListener("bufferedamountlow", onLow);
      channel.removeEventListener("close", onClose);
    };
    channel.addEventListener("bufferedamountlow", onLow);
    channel.addEventListener("close", onClose);
    if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) onLow();
  });
  if (channel.readyState !== "open") throw new Error("P2P-соединение прервано.");
}

async function sendMediaFiles(files) {
  const contact = currentContact;
  if (!contact) return;
  if (!contact.online) {
    showToast("Фото и видео можно отправить, когда собеседник в сети.");
    return;
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    showToast("Нет соединения с сервером");
    return;
  }
  for (const file of files) {
    if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
      showToast(`${file.name}: выберите изображение или видео.`);
      continue;
    }
    if (file.size < 1 || file.size > MAX_MEDIA_BYTES) {
      showToast(`${file.name}: максимальный размер — 50 МБ.`);
      continue;
    }
    try {
      await sendMediaFile(file, contact);
    } catch (error) {
      console.error("Не удалось передать файл:", error);
      showToast(error.message || "Не удалось передать файл.");
      updateTransferStatus(`Ошибка передачи: ${file.name}`);
    }
  }
}

async function sendMediaFile(file, contact) {
  updateTransferStatus(`Соединяемся с ${contact.name}…`);
  const channel = await ensureFileChannel(contact.id);
  if (channel.readyState !== "open") throw new Error("P2P-канал передачи файла недоступен.");
  const messageId = crypto.randomUUID();
  const transferId = crypto.randomUUID();
  const transferHeader = new TextEncoder().encode(transferId);
  await storeMediaAttachment(messageId, file);
  let acknowledgement;
  try {
    const ackPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        outgoingTransfers.delete(transferId);
        reject(new Error("Собеседник не подтвердил получение файла."));
      }, 180_000);
      outgoingTransfers.set(transferId, {
        peerId: contact.id,
        resolve,
        reject,
        timeout
      });
    });
    void ackPromise.catch(() => {});
    channel.send(JSON.stringify({
      kind: "start",
      transferId,
      messageId,
      name: file.name,
      mimeType: file.type,
      size: file.size
    }));
    let lastProgressUpdate = 0;
    for (let offset = 0; offset < file.size; offset += FILE_CHUNK_BYTES) {
      await waitForFileBuffer(channel);
      const chunk = new Uint8Array(await file.slice(offset, offset + FILE_CHUNK_BYTES).arrayBuffer());
      const frame = new Uint8Array(transferHeader.length + chunk.length);
      frame.set(transferHeader);
      frame.set(chunk, transferHeader.length);
      channel.send(frame.buffer);
      const sentBytes = Math.min(file.size, offset + chunk.length);
      if (sentBytes - lastProgressUpdate >= 512 * 1024 || sentBytes === file.size) {
        updateTransferStatus(`Отправка ${file.name}: ${Math.round((sentBytes / file.size) * 100)}%`);
        lastProgressUpdate = sentBytes;
      }
    }
    channel.send(JSON.stringify({ kind: "end", transferId }));
    await ackPromise;
    acknowledgement = true;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Файл доставлен, но сервер отключился до сохранения сообщения. Повторите отправку.");
    }
    socket.send(JSON.stringify({
      type: "attachment",
      toId: contact.id,
      attachment: {
        id: messageId,
        name: file.name,
        mimeType: file.type,
        size: file.size
      }
    }));
    updateTransferStatus(`Файл отправлен: ${file.name}`);
    setTimeout(() => {
      if (transferStatus.textContent === `Файл отправлен: ${file.name}`) transferStatus.classList.add("hidden");
    }, 5000);
  } catch (error) {
    const transfer = outgoingTransfers.get(transferId);
    if (transfer) {
      clearTimeout(transfer.timeout);
      outgoingTransfers.delete(transferId);
    }
    if (channel.readyState === "open") channel.send(JSON.stringify({ kind: "abort", transferId }));
    if (!acknowledgement) {
      try {
        await removeMediaAttachment(messageId);
      } catch (storageError) {
        console.error("Не удалось удалить незавершённое вложение:", storageError);
      }
    }
    throw error;
  }
}

async function handleFileDataMessage(link, event) {
  const channel = link.channel;
  if (typeof event.data === "string") {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      throw new Error("Получено некорректное сообщение P2P-канала.");
    }
    if (payload.kind === "start") {
      const validFileType = typeof payload.mimeType === "string" &&
        (/^image\/[a-z0-9.+-]{1,64}$/i.test(payload.mimeType) || /^video\/[a-z0-9.+-]{1,64}$/i.test(payload.mimeType));
      if (
        typeof payload.transferId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(payload.transferId) ||
        typeof payload.messageId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(payload.messageId) ||
        typeof payload.name !== "string" ||
        payload.name.length < 1 ||
        payload.name.length > 255 ||
        !validFileType ||
        !Number.isSafeInteger(payload.size) ||
        payload.size < 1 ||
        payload.size > MAX_MEDIA_BYTES ||
        incomingTransfers.size >= 3
      ) {
        channel.send(JSON.stringify({ kind: "error", transferId: payload.transferId || "", error: "Файл не прошёл проверку или превышает лимит 50 МБ." }));
        return;
      }
      incomingTransfers.set(payload.transferId, {
        peerId: link.peerId,
        messageId: payload.messageId,
        name: payload.name.replace(/[\\/\u0000-\u001f]/g, "_"),
        mimeType: payload.mimeType,
        size: payload.size,
        received: 0,
        chunks: []
      });
      updateTransferStatus(`Получение файла: ${payload.name} · 0%`);
      return;
    }
    if (payload.kind === "end") {
      const transfer = incomingTransfers.get(payload.transferId);
      if (!transfer || transfer.peerId !== link.peerId || transfer.received !== transfer.size) {
        channel.send(JSON.stringify({ kind: "error", transferId: payload.transferId || "", error: "Получен неполный файл." }));
        incomingTransfers.delete(payload.transferId);
        return;
      }
      const blob = new Blob(transfer.chunks, { type: transfer.mimeType });
      await storeMediaAttachment(transfer.messageId, blob);
      channel.send(JSON.stringify({ kind: "received", transferId: payload.transferId }));
      incomingTransfers.delete(payload.transferId);
      updateTransferStatus(`Файл получен: ${transfer.name}`);
      setTimeout(() => {
        if (transferStatus.textContent === `Файл получен: ${transfer.name}`) transferStatus.classList.add("hidden");
      }, 5000);
      return;
    }
    if (payload.kind === "received" || payload.kind === "error") {
      const transfer = outgoingTransfers.get(payload.transferId);
      if (!transfer || transfer.peerId !== link.peerId) return;
      clearTimeout(transfer.timeout);
      outgoingTransfers.delete(payload.transferId);
      if (payload.kind === "received") transfer.resolve();
      else transfer.reject(new Error(payload.error || "Собеседник не смог сохранить файл."));
      return;
    }
    if (payload.kind === "abort") {
      incomingTransfers.delete(payload.transferId);
      return;
    }
    throw new Error("Получена неизвестная команда P2P-канала.");
  }

  if (!(event.data instanceof ArrayBuffer) || event.data.byteLength <= 36) {
    throw new Error("Получен некорректный блок файла.");
  }
  const bytes = new Uint8Array(event.data);
  const transferId = new TextDecoder().decode(bytes.subarray(0, 36));
  const transfer = incomingTransfers.get(transferId);
  if (!transfer || transfer.peerId !== link.peerId) return;
  const chunk = bytes.slice(36);
  if (transfer.received + chunk.length > transfer.size) {
    incomingTransfers.delete(transferId);
    channel.send(JSON.stringify({ kind: "error", transferId, error: "Размер полученного файла не совпадает." }));
    return;
  }
  transfer.chunks.push(chunk);
  transfer.received += chunk.length;
  if (transfer.received === transfer.size || transfer.received % (1024 * 1024) < chunk.length) {
    updateTransferStatus(`Получение файла: ${Math.round((transfer.received / transfer.size) * 100)}%`);
  }
}

async function handleFileSignal(payload) {
  const { from, signal } = payload;
  if (!from || !signal || typeof from.id !== "string") return;
  if (signal.kind === "request") {
    if (currentUser.id.localeCompare(from.id) >= 0) return;
    const existing = fileLinks.get(from.id);
    if (existing && existing.pc.connectionState !== "failed" && existing.pc.connectionState !== "closed") return;
    if (existing) existing.pc.close();
    createFileLink(from.id, true);
    return;
  }

  let link = fileLinks.get(from.id);
  if (!link && signal.kind === "offer") link = createFileLink(from.id, false);
  if (!link && signal.kind === "candidate") link = createFileLink(from.id, false);
  if (!link) return;
  if (signal.kind === "offer") {
    if (link.isOfferer) return;
    await link.pc.setRemoteDescription(signal.description);
    for (const candidate of link.pendingCandidates.splice(0)) await link.pc.addIceCandidate(candidate);
    const answer = await link.pc.createAnswer();
    await link.pc.setLocalDescription(answer);
    sendFileSignal(from.id, { kind: "answer", description: link.pc.localDescription });
    return;
  }
  if (signal.kind === "answer" && link.isOfferer) {
    await link.pc.setRemoteDescription(signal.description);
    for (const candidate of link.pendingCandidates.splice(0)) await link.pc.addIceCandidate(candidate);
    return;
  }
  if (signal.kind === "candidate") {
    if (link.pc.remoteDescription) await link.pc.addIceCandidate(signal.candidate);
    else link.pendingCandidates.push(signal.candidate);
  }
}

messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 120)}px`;
  sendTyping(true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => sendTyping(false), 900);
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    document.querySelector("#message-form").requestSubmit();
  }
});

function connectWebSocket() {
  if (!localStorage.getItem(TOKEN_KEY)) return;
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "auth", token: localStorage.getItem(TOKEN_KEY) }));
  });
  socket.addEventListener("message", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      console.error("Сервер прислал некорректный JSON.");
      showToast("Получен некорректный ответ сервера. Обновите страницу.");
      return;
    }
    handleSocketMessage(payload);
  });
  socket.addEventListener("close", (event) => {
    if (event.code === 4001) {
      localStorage.removeItem(TOKEN_KEY);
      appScreen.classList.add("hidden");
      authScreen.classList.remove("hidden");
      authError.textContent = "Сессия истекла. Войдите снова.";
      authError.hidden = false;
      return;
    }
    if (localStorage.getItem(TOKEN_KEY)) reconnectTimer = setTimeout(connectWebSocket, 1800);
  });
  socket.addEventListener("error", () => showToast("Проблема с соединением. Переподключаемся..."));
}

function handleSocketMessage(payload) {
  if (payload.type === "ready") {
    for (const contact of contacts) contact.online = payload.online.includes(contact.id);
    renderSidebar();
    return;
  }
  if (payload.type === "message") {
    const message = payload.message;
    if (message.fromId !== currentUser.id) {
      const sender = contactById(message.fromId);
      const senderName = sender?.name || "Новый контакт";
      const preview = message.text.length > 120 ? `${message.text.slice(0, 117)}…` : message.text;
      showNotification(`Сообщение от ${senderName}`, preview, message.fromId, true);
      playMessageSound();
    }
    if (currentContact && (message.fromId === currentContact.id || message.toId === currentContact.id)) {
      loadCurrentConversation();
    }
    loadChats().catch((error) => showToast(error.message));
    return;
  }
  if (payload.type === "attachment") {
    const message = payload.message;
    if (message.fromId !== currentUser.id) {
      const sender = contactById(message.fromId);
      showNotification(
        `Вложение от ${sender?.name || "контакта"}`,
        message.attachment.name,
        message.fromId,
        true
      );
      playMessageSound();
    }
    if (currentContact && (message.fromId === currentContact.id || message.toId === currentContact.id)) {
      loadCurrentConversation();
    }
    loadChats().catch((error) => showToast(error.message));
    return;
  }
  if (payload.type === "reaction") {
    if (currentContact && payload.toId === currentContact.id) loadCurrentConversation();
    loadChats().catch((error) => showToast(error.message));
    return;
  }
  if (payload.type === "presence") {
    const contact = contactById(payload.userId);
    if (contact) contact.online = payload.online;
    if (currentContact?.id === payload.userId) {
      const status = document.querySelector("#chat-status");
      status.textContent = payload.online ? "в сети" : `@${currentContact.username}`;
      status.classList.toggle("online-label", payload.online);
    }
    renderSidebar();
    return;
  }
  if (payload.type === "typing") {
    if (currentContact?.id === payload.fromId) {
      const indicator = document.querySelector("#typing-indicator");
      indicator.hidden = !payload.active;
    }
    return;
  }
  if (payload.type === "contacts-updated") {
    Promise.all([loadContacts(), loadChats()]).catch((error) => showToast(error.message));
    return;
  }
  if (payload.type === "profile-updated" && payload.user && payload.user.id === currentUser?.id) {
    currentUser = payload.user;
    updateProfilePresentation();
    return;
  }
  if (payload.type === "signal") handleCallSignal(payload);
  if (payload.type === "file-signal") {
    void handleFileSignal(payload).catch((error) => {
      console.error("Не удалось обработать сигнал P2P:", error);
      const link = payload.from?.id ? fileLinks.get(payload.from.id) : null;
      if (link) failFileLink(link, error);
      showToast("Не удалось установить соединение для передачи файла.");
    });
  }
  if (payload.type === "error") showToast(payload.error);
}

async function loadCurrentConversation() {
  if (!currentContact) return;
  const contactId = currentContact.id;
  try {
    const result = await api(`/api/messages?with=${encodeURIComponent(contactId)}`);
    if (currentContact?.id === contactId) renderMessages(result.messages);
  } catch (error) {
    showToast(error.message);
  }
}

document.querySelector("#back-button").addEventListener("click", () => appScreen.classList.remove("chat-open"));
document.querySelector("#logout-button").addEventListener("click", () => {
  void removePushSubscription();
  localStorage.removeItem(TOKEN_KEY);
  clearTimeout(reconnectTimer);
  for (const link of fileLinks.values()) link.pc.close();
  fileLinks.clear();
  incomingTransfers.clear();
  socket?.close();
  socket = null;
  currentUser = null;
  contacts = [];
  chats = [];
  currentContact = null;
  appScreen.classList.add("hidden");
  authScreen.classList.remove("hidden");
  authForm.reset();
  setAuthMode("login");
});

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchInput.focus();
  }
});

const audioCallButton = document.querySelector("#audio-call-button");
const videoCallButton = document.querySelector("#video-call-button");
audioCallButton.addEventListener("click", () => startCall(false));
videoCallButton.addEventListener("click", () => startCall(true));

async function startCall(video) {
  if (!currentContact || !socket || socket.readyState !== WebSocket.OPEN) {
    showToast("Нет соединения с сервером");
    return;
  }
  if (!currentContact.online) {
    showToast("Собеседник сейчас не в сети");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("Звонки доступны на localhost или сайте с HTTPS.");
    return;
  }
  if (!window.isSecureContext) {
    showToast("Для звонков откройте сайт через HTTPS или localhost.");
    return;
  }
  activeCallPeer = currentContact;
  document.querySelector("#call-title").textContent = `Звоним: ${currentContact.name}`;
  document.querySelector("#remote-name").textContent = currentContact.name;
  document.querySelector("#call-status").textContent = "Вызов...";
  document.querySelector("#incoming-actions").hidden = true;
  document.querySelector("#call-controls").hidden = false;
  callDialog.showModal();
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    document.querySelector("#local-video").srcObject = localStream;
    peerConnection = createPeerConnection(currentContact.id);
    localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendSignal(currentContact.id, { kind: "offer", description: peerConnection.localDescription, video });
    callTimer = setTimeout(() => {
      if (peerConnection && peerConnection.connectionState !== "connected") {
        endCall(true);
        showToast("Нет ответа на звонок");
      }
    }, 45_000);
  } catch (error) {
    endCall(false);
    showToast(error.name === "NotAllowedError" ? "Разрешите доступ к микрофону и камере." : "Не удалось начать звонок.");
  }
}

function createPeerConnection(targetId) {
  const connection = new RTCPeerConnection({
    iceServers
  });
  connection.onicecandidate = (event) => {
    if (event.candidate) sendSignal(targetId, { kind: "candidate", candidate: event.candidate });
  };
  connection.ontrack = (event) => {
    document.querySelector("#remote-video").srcObject = event.streams[0];
    document.querySelector("#remote-placeholder").classList.add("hidden");
    document.querySelector("#call-status").textContent = "На связи";
  };
  connection.onconnectionstatechange = () => {
    if (connection.connectionState === "connected") {
      clearTimeout(callTimer);
      document.querySelector("#call-status").textContent = "На связи";
    }
    if (connection.connectionState === "failed") {
      document.querySelector("#call-status").textContent = "Не удалось соединиться";
      showToast("Звонок не прошёл. В этой сети может понадобиться TURN-сервер.");
    }
  };
  return connection;
}

function sendSignal(toId, signal) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "signal", toId, signal }));
}

async function handleCallSignal(payload) {
  const { signal, from } = payload;
  if (signal.kind === "offer") {
    if (peerConnection || incomingCall || activeCallPeer) {
      sendSignal(from.id, { kind: "hangup" });
      return;
    }
    incomingCall = { from, description: signal.description, video: Boolean(signal.video) };
    activeCallPeer = from;
    document.querySelector("#call-title").textContent = "Входящий звонок";
    document.querySelector("#remote-name").textContent = from.name;
    document.querySelector("#call-status").textContent = signal.video ? "Видеозвонок" : "Аудиозвонок";
    document.querySelector("#incoming-actions").hidden = false;
    document.querySelector("#call-controls").hidden = true;
    document.querySelector("#remote-placeholder").classList.remove("hidden");
    callDialog.showModal();
    showNotification(
      `Входящий звонок от ${from.name}`,
      signal.video ? "Видеозвонок" : "Аудиозвонок",
      from.id,
      true
    );
    startCallSound();
    callTimer = setTimeout(() => {
      if (incomingCall) {
        endCall(false);
        showToast("Пропущенный звонок");
      }
    }, 45_000);
    return;
  }
  if (signal.kind === "candidate" && !peerConnection && incomingCall?.from.id === from.id) {
    queuedCandidates.push(signal.candidate);
    return;
  }
  if (!peerConnection || activeCallPeer?.id !== from.id) {
    if (signal.kind === "hangup" && incomingCall?.from.id === from.id) endCall(false);
    return;
  }
  try {
    if (signal.kind === "answer") {
      await peerConnection.setRemoteDescription(signal.description);
      await drainCandidates();
      document.querySelector("#call-status").textContent = "Соединяем...";
    } else if (signal.kind === "candidate") {
      if (peerConnection.remoteDescription) await peerConnection.addIceCandidate(signal.candidate);
      else queuedCandidates.push(signal.candidate);
    } else if (signal.kind === "hangup") {
      endCall(false);
      showToast("Собеседник завершил звонок");
    }
  } catch {
    endCall(false);
    showToast("Не удалось установить соединение.");
  }
}

async function drainCandidates() {
  const candidates = queuedCandidates;
  queuedCandidates = [];
  for (const candidate of candidates) await peerConnection.addIceCandidate(candidate);
}

document.querySelector("#answer-call-button").addEventListener("click", async () => {
  if (!incomingCall) return;
  const call = incomingCall;
  stopCallSound();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    sendSignal(call.from.id, { kind: "hangup" });
    endCall(false);
    showToast("Для звонков откройте сайт через HTTPS или localhost.");
    return;
  }
  try {
    clearTimeout(callTimer);
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: call.video });
    document.querySelector("#local-video").srcObject = localStream;
    document.querySelector("#incoming-actions").hidden = true;
    document.querySelector("#call-controls").hidden = false;
    peerConnection = createPeerConnection(call.from.id);
    localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
    await peerConnection.setRemoteDescription(call.description);
    await drainCandidates();
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    sendSignal(call.from.id, { kind: "answer", description: peerConnection.localDescription });
    incomingCall = null;
    document.querySelector("#call-status").textContent = "Соединяем...";
    callTimer = setTimeout(() => {
      if (peerConnection && peerConnection.connectionState !== "connected") {
        endCall(true);
        showToast("Не удалось установить соединение");
      }
    }, 45_000);
  } catch {
    sendSignal(call.from.id, { kind: "hangup" });
    endCall(false);
    showToast("Не удалось ответить. Проверьте доступ к микрофону и камере.");
  }
});

document.querySelector("#decline-call-button").addEventListener("click", () => endCall(true));
document.querySelector("#end-call-button").addEventListener("click", () => endCall(true));
document.querySelector("#close-call-button").addEventListener("click", () => endCall(true));
callDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  endCall(true);
});

function endCall(notifyPeer = true) {
  clearTimeout(callTimer);
  callTimer = null;
  stopCallSound();
  const peerId = activeCallPeer?.id || incomingCall?.from.id;
  if (notifyPeer && peerId) sendSignal(peerId, { kind: "hangup" });
  peerConnection?.close();
  peerConnection = null;
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  incomingCall = null;
  activeCallPeer = null;
  queuedCandidates = [];
  muted = false;
  cameraOff = false;
  document.querySelector("#local-video").srcObject = null;
  document.querySelector("#remote-video").srcObject = null;
  document.querySelector("#remote-placeholder").classList.remove("hidden");
  document.querySelector("#call-controls").hidden = false;
  document.querySelector("#incoming-actions").hidden = true;
  document.querySelector("#mute-button").classList.remove("off");
  document.querySelector("#camera-button").classList.remove("off");
  document.querySelector("#mute-button").setAttribute("aria-label", "Выключить микрофон");
  document.querySelector("#camera-button").setAttribute("aria-label", "Выключить камеру");
  if (callDialog.open) callDialog.close();
}

document.querySelector("#mute-button").addEventListener("click", (event) => {
  muted = !muted;
  localStream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  event.currentTarget.classList.toggle("off", muted);
  event.currentTarget.setAttribute("aria-label", muted ? "Включить микрофон" : "Выключить микрофон");
});

document.querySelector("#camera-button").addEventListener("click", (event) => {
  cameraOff = !cameraOff;
  localStream?.getVideoTracks().forEach((track) => { track.enabled = !cameraOff; });
  event.currentTarget.classList.toggle("off", cameraOff);
  event.currentTarget.setAttribute("aria-label", cameraOff ? "Включить камеру" : "Выключить камеру");
});

document.querySelector("#call-dialog").addEventListener("click", (event) => {
  if (event.target === callDialog) endCall(true);
});

async function resumeSession() {
  if (!localStorage.getItem(TOKEN_KEY)) return;
  try {
    await enterMessenger();
  } catch (error) {
    localStorage.removeItem(TOKEN_KEY);
    currentUser = null;
    authError.textContent = error.message;
    authError.hidden = false;
  }
}

resumeSession();
