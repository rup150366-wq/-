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
      vibrate: [120, 60, 120],
      data: { contactId: payload.contactId || null }
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const contactId = event.notification.data?.contactId;
  const target = new URL("/", self.location.origin);
  if (contactId) target.searchParams.set("contact", contactId);

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const appClient = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (appClient) {
      await appClient.focus();
      if (contactId) appClient.postMessage({ type: "notification-click", contactId });
      return;
    }
    await self.clients.openWindow(target.toString());
  })());
});
