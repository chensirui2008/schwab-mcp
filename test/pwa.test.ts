import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { AppEnv } from "../src/env";
import manifestRaw from "../public/manifest.webmanifest?raw";
import swJs from "../public/sw.js?raw";
import offlineHtml from "../public/offline.html?raw";
import headersText from "../public/_headers?raw";

const origin = "https://example.com";

function mockLimiter(): RateLimit {
  return {
    limit() {
      return Promise.resolve({ success: true });
    },
  };
}

function setup() {
  const appEnv = { ...env } as unknown as AppEnv;
  appEnv.BROWSER_AUTH_RATE_LIMITER = mockLimiter();
  appEnv.ACCEPTANCE_BROWSER_AUTH_RATE_LIMITER = mockLimiter();
  return appEnv;
}

async function dispatch(request: Request, appEnv: AppEnv) {
  let req = request;
  if (!req.headers.has("CF-Connecting-IP")) {
    const headers = new Headers(req.headers);
    headers.set("CF-Connecting-IP", "192.0.2.10");
    req = new Request(req, { headers });
  }
  const ctx = createExecutionContext();
  const response = await worker.fetch(req, appEnv, ctx);
  const body = response.body === null ? null : await response.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function cookie(response: Response, name: string) {
  return response.headers.get("set-cookie")?.match(new RegExp(`${name}=([^;]+)`))?.[0] ?? "";
}

async function login(appEnv: AppEnv, path = "/dashboard") {
  const start = await dispatch(new Request(`${origin}${path}`), appEnv);
  expect(start.status).toBe(302);
  const github = new URL(start.headers.get("location") ?? "");
  const githubFetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ access_token: "fake-dashboard-github-token" }))
    .mockResolvedValueOnce(Response.json({ id: Number(appEnv.ALLOWED_GITHUB_USER_ID), login: "owner", name: null }));
  vi.stubGlobal("fetch", githubFetch);
  const callback = await dispatch(new Request(`${origin}/auth/github/callback?state=${github.searchParams.get("state") ?? ""}&code=fake-code`, {
    headers: { Cookie: cookie(start, "__Host-schwab-oauth") },
  }), appEnv);
  vi.unstubAllGlobals();
  expect(callback.status).toBe(302);
  const securityCookie = cookie(callback, "__Host-schwab-security");
  expect(securityCookie).toBeTruthy();
  return securityCookie;
}

describe("PWA Assets and Specification", () => {
  it("has valid manifest.webmanifest with required PWA metadata", () => {
    interface ManifestShape {
      id: string;
      start_url: string;
      scope: string;
      display: string;
      lang: string;
      name: string;
      short_name: string;
      theme_color: string;
      background_color: string;
      icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
    }
    const manifest = JSON.parse(manifestRaw) as ManifestShape;
    expect(manifest.id).toBe("/dashboard");
    expect(manifest.start_url).toBe("/dashboard");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.lang).toBe("zh-CN");
    expect(manifest.name).toBe("Schwab MCP");
    expect(manifest.short_name).toBe("Schwab MCP");
    expect(manifest.theme_color).toBe("#070b12");
    expect(manifest.background_color).toBe("#070b12");
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThanOrEqual(4);

    const icon192 = manifest.icons.find((i: { sizes: string }) => i.sizes === "192x192");
    const icon512 = manifest.icons.find((i: { sizes: string; purpose?: string }) => i.sizes === "512x512" && !i.purpose);
    const maskable512 = manifest.icons.find((i: { sizes: string; purpose?: string }) => i.sizes === "512x512" && i.purpose === "maskable");
    const apple180 = manifest.icons.find((i: { sizes: string }) => i.sizes === "180x180");

    expect(icon192).toBeDefined();
    expect(icon512).toBeDefined();
    expect(maskable512).toBeDefined();
    expect(apple180).toBeDefined();
  });

  it("has unauthenticated offline fallback page without sensitive data or tokens", () => {
    expect(offlineHtml).toContain("<!DOCTYPE html>");
    expect(offlineHtml).toContain("离线状态");
    expect(offlineHtml).toContain("viewport-fit=cover");
    expect(offlineHtml).not.toContain("token");
    expect(offlineHtml).not.toContain("orderId");
    expect(offlineHtml).not.toContain("hashValue");
    expect(offlineHtml).not.toContain("csrf");
  });

  it("has correct _headers configuration for SW, manifest and assets", () => {
    expect(headersText).toContain("/sw.js");
    expect(headersText).toContain("Cache-Control: no-cache, no-store, must-revalidate");
    expect(headersText).toContain("/manifest.webmanifest");
    expect(headersText).toContain("Content-Type: application/manifest+json");
    expect(headersText).toContain("X-Content-Type-Options: nosniff");
  });

  it("has Service Worker that pre-caches only static assets and handles push/notificationclick safely", () => {
    expect(swJs).toContain("STATIC_ASSETS = [");
    expect(swJs).toContain("/offline.html");
    expect(swJs).toContain("/manifest.webmanifest");
    expect(swJs).toContain("/icons/icon-192.png");
    // Ensure SW never caches API, MCP or OAuth
    expect(swJs).toContain("url.pathname.startsWith(\"/mcp\")");
    // Ensure SW checks UUID on notification click
    expect(swJs).toContain("UUID_REGEX");
    expect(swJs).toContain("/dashboard/notifications/");
  });

  it("serves dashboard and security with PWA head tags, safe-area viewport and enhanced CSP", async () => {
    const appEnv = setup();
    const securityCookie = await login(appEnv);

    // Test dashboard page
    const dashboardRes = await dispatch(new Request(`${origin}/dashboard`, { headers: { Cookie: securityCookie } }), appEnv);
    expect(dashboardRes.status).toBe(200);
    const csp = dashboardRes.headers.get("Content-Security-Policy");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("manifest-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");

    const dashboardHtml = await dashboardRes.text();
    expect(dashboardHtml).toContain('content="width=device-width, initial-scale=1, viewport-fit=cover"');
    expect(dashboardHtml).toContain('href="/manifest.webmanifest"');
    expect(dashboardHtml).toContain('name="theme-color" content="#070b12"');
    expect(dashboardHtml).toContain('href="/icons/apple-touch-icon.png"');
    expect(dashboardHtml).toContain("navigator.serviceWorker.register('/sw.js'");

    // Test security page
    const securityRes = await dispatch(new Request(`${origin}/security`, { headers: { Cookie: securityCookie } }), appEnv);
    expect(securityRes.status).toBe(200);
    const securityCsp = securityRes.headers.get("Content-Security-Policy");
    expect(securityCsp).toContain("worker-src 'self'");
    expect(securityCsp).toContain("manifest-src 'self'");

    const securityHtml = await securityRes.text();
    expect(securityHtml).toContain('content="width=device-width, initial-scale=1, viewport-fit=cover"');
    expect(securityHtml).toContain('href="/manifest.webmanifest"');
    expect(securityHtml).toContain('name="theme-color" content="#070b12"');
    expect(securityHtml).toContain('href="/dashboard"');
    expect(securityHtml).toContain("navigator.serviceWorker.register('/sw.js'");
  });
});
