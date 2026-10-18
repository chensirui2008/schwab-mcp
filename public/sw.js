// Service Worker for Schwab MCP PWA
const CACHE_NAME = "schwab-mcp-static-v1";
const STATIC_ASSETS = [
  "/offline.html",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-512-maskable.png",
  "/icons/apple-touch-icon.png",
];

const NOTIFICATION_TEMPLATES = {
  CLIENT_AUTHORIZATION_PENDING: {
    title: "客户端授权待批准",
    body: "有客户端正在申请访问权限，需要 Passkey 批准。",
  },
  CLIENT_AUTHORIZED: {
    title: "客户端授权已完成",
    body: "客户端已成功获得授权并签发凭据。",
  },
  TRADE_APPROVAL_PENDING: {
    title: "交易提案待批准",
    body: "有交易订单或受保护任务修改待 Passkey 批准。",
  },
  TRADE_RESULT: {
    title: "交易请求状态更新",
    body: "交易请求处理完成或状态发生变动，请在应用中查看详情。",
  },
  SCHWAB_REAUTH_DUE_SOON: {
    title: "Schwab 授权即将到期",
    body: "Schwab 凭据即将在 24 小时内到期，请及时重新授权。",
  },
  SCHWAB_REAUTH_REQUIRED: {
    title: "Schwab 授权已失效",
    body: "Schwab 授权已失效，请重新连接以恢复交易与行情服务。",
  },
  TEST: {
    title: "测试通知",
    body: "这是一条测试推送提醒，推送通道配置正常。",
  },
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  // Do not call self.skipWaiting() automatically to avoid interrupting pending ceremonies
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // NEVER cache API, MCP, OAuth, or POST/PUT/DELETE requests
  if (req.method !== "GET" || url.pathname.startsWith("/mcp") || url.pathname.includes("/api/") || url.pathname.startsWith("/auth/")) {
    return;
  }

  // Static assets: serve from cache if available
  if (STATIC_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req))
    );
    return;
  }

  // Navigation requests for dashboard or security: network-first, fallback to offline.html
  if (req.mode === "navigate" && (url.pathname.startsWith("/dashboard") || url.pathname.startsWith("/security"))) {
    event.respondWith(
      fetch(req).catch(() => {
        return caches.match("/offline.html").then((offlineRes) => {
          return offlineRes || new Response("离线状态", {
            status: 503,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
        });
      })
    );
    return;
  }
});

// Push notification handling
self.addEventListener("push", (event) => {
  let title = "Schwab MCP 提醒";
  let body = "有一条新提醒，请打开应用查看";
  let eventId = null;

  if (event.data) {
    try {
      const payload = event.data.json();
      if (payload && typeof payload === "object") {
        if (typeof payload.eventId === "string" && UUID_REGEX.test(payload.eventId)) {
          eventId = payload.eventId;
        }
        if (typeof payload.type === "string" && NOTIFICATION_TEMPLATES[payload.type]) {
          title = NOTIFICATION_TEMPLATES[payload.type].title;
          body = NOTIFICATION_TEMPLATES[payload.type].body;
        }
      }
    } catch {
      // payload parsing failed, use safe default fallback
    }
  }

  const options = {
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: eventId ? `event-${eventId}` : "schwab-mcp-notification",
    renotify: true,
    data: {
      eventId: eventId,
    },
  };

  event.waitUntil(
    self.registration.showNotification(title, options).then(() => {
      // Notify active clients to refresh notifications list if open
      return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
        for (const client of clients) {
          client.postMessage({ type: "PUSH_RECEIVED", eventId });
        }
      });
    })
  );
});

// Click notification: navigate to /dashboard/notifications/{eventId} or /dashboard
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const eventId = event.notification.data?.eventId;
  let targetPath = "/dashboard";
  if (eventId && UUID_REGEX.test(eventId)) {
    targetPath = `/dashboard/notifications/${eventId}`;
  }

  const targetUrl = new URL(targetPath, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (new URL(client.url).origin === self.location.origin) {
          if ("navigate" in client) {
            return client.navigate(targetUrl).then((navigatedClient) => {
              return navigatedClient ? navigatedClient.focus() : client.focus();
            });
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
