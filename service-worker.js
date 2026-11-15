self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (clients.some((client) => client.visibilityState === "visible")) return;
    await self.registration.showNotification(payload.title || "Бурундук", {
      body: payload.body || "Новое сообщение",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: payload.tag || `burunduk-${payload.contactId || "message"}`,
      renotify: true,
      vibrate: payload.vibrationEnabled === false ? [] : [120, 60, 120],
      requireInteraction: payload.type === "call" || payload.type === "group-call",
      data: {
        contactId: payload.contactId || null,
        groupId: payload.groupId || null,
        type: payload.type || "message",
        callType: payload.callType || null
      }
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const notificationData = event.notification.data || {};
  const contactId = notificationData.contactId;
  const groupId = notificationData.groupId;
  const target = new URL("/", self.location.origin);
  if (contactId) target.searchParams.set("contact", contactId);
  if (groupId) target.searchParams.set("group", groupId);
  if (notificationData.type === "call" || notificationData.type === "group-call") target.searchParams.set("missedCall", "1");

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const appClient = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (appClient) {
      await appClient.focus();
      if (groupId) {
        appClient.postMessage({
          type: "notification-click",
          groupId,
          notificationType: notificationData.type || "message"
        });
      } else if (contactId) {
        appClient.postMessage({
          type: "notification-click",
          contactId,
          notificationType: notificationData.type || "message"
        });
      }
      return;
    }
    await self.clients.openWindow(target.toString());
  })());
});
