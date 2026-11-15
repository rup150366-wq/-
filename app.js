const TOKEN_KEY = "burunduk-token";
const THEME_KEY = "burunduk-theme";
const ANIMAL_AVATARS = ["🐿️", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐸", "🐵", "🐰", "🦝", "🦉", "🦔", "🐹", "🐶", "🐱", "🐧", "🐤"];
const authScreen = document.querySelector("#auth-screen");
const appScreen = document.querySelector("#app-screen");
const authForm = document.querySelector("#auth-form");
const authError = document.querySelector("#auth-error");
const sidebarList = document.querySelector("#sidebar-list");
const searchInput = document.querySelector("#search-input");
const messagesArea = document.querySelector("#messages-area");
const messagesElement = document.querySelector("#messages");
const messageInput = document.querySelector("#message-input");
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
let pendingNotificationContactId = new URLSearchParams(location.search).get("contact");
let notificationsEnabled = localStorage.getItem("burunduk-notifications") !== "false";
let soundEnabled = localStorage.getItem("burunduk-sound") !== "false";

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);
  if (!serviceWorkerReady) {
    serviceWorkerReady = navigator.serviceWorker.register("/service-worker.js?v=2", { scope: "/" })
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
      openNotificationContact(event.data.contactId);
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

function openNotificationContact(contactId) {
  const contact = contactById(contactId);
  if (contact) {
    pendingNotificationContactId = null;
    focusContact(contact);
    return;
  }
  pendingNotificationContactId = contactId;
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
      history.replaceState(null, "", location.pathname);
      await selectContact(contact);
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
    preview.textContent = activeSection === "chats" ? (entry.lastMessage?.text || "") : `@${entry.username}`;
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
  messagesElement.replaceChildren();
  for (const message of items) {
    const own = message.fromId === currentUser.id;
    const row = document.createElement("div");
    row.className = `message-row${own ? " own" : ""}`;
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
    bubble.textContent = message.text;
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = formatMessageTime(message.createdAt);
    wrap.append(bubble, meta);
    row.append(wrap);
    messagesElement.append(row);
  }
  messagesArea.scrollTop = messagesArea.scrollHeight;
}

async function selectContact(contact) {
  if (!contact) return;
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
  socket.send(JSON.stringify({ type: "message", toId: currentContact.id, text }));
  messageInput.value = "";
  sendTyping(false);
  messageInput.focus();
});

document.querySelector(".emoji-button").addEventListener("click", () => {
  messageInput.value += " 🙂";
  messageInput.focus();
});

function sendTyping(active) {
  if (socket?.readyState === WebSocket.OPEN && currentContact) {
    socket.send(JSON.stringify({ type: "typing", toId: currentContact.id, active }));
  }
}

messageInput.addEventListener("input", () => {
  sendTyping(true);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => sendTyping(false), 900);
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
    showNotification(`Входящий звонок от ${from.name}`, signal.video ? "Видеозвонок" : "Аудиозвонок", from.id);
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
