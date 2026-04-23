/**
 * Static UI serving for the Maple Self Hosted Angular bundle.
 *
 * In production: serves the compiled Angular app from the dist directory.
 *   - Static files from /api/* are handled by API routes first.
 *   - All other GET requests (Angular routes) fall through to index.html (SPA).
 *
 * In development (MAPLE_DEV=1): proxies to Angular dev server at
 *   MAPLE_DEV_ORIGIN (default: http://localhost:4201).
 *
 * The UI dist path is resolved relative to this server's root:
 *   <api>/../../web/dist/maple-self-hosted/browser/
 * Can be overridden via MAPLE_UI_DIST env var.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Elysia } from "elysia";

const IS_DEV = process.env.MAPLE_DEV === "1";
const DEV_ORIGIN = process.env.MAPLE_DEV_ORIGIN ?? "http://localhost:4201";

/** Absolute path to the Angular production build. */
function resolveUiDist(): string {
  if (process.env.MAPLE_UI_DIST) {
    return process.env.MAPLE_UI_DIST;
  }
  // Relative to this file's location: src/routes/ → .. → src/ → .. → api/
  // Then up one more to the monorepo src/: ../web/dist/maple-self-hosted/browser/
  return path.resolve(
    import.meta.dir, // src/routes/
    "..",            // src/
    "..",            // api/
    "..",            // src/      (monorepo src/)
    "web",
    "dist",
    "maple-self-hosted",
    "browser"
  );
}

const UI_DIST = resolveUiDist();

/** MIME type map for static serving. */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript",
  ".mjs":  "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".svg":  "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".woff":  "font/woff",
  ".woff2": "font/woff2",
  ".ttf":   "font/ttf",
  ".map":   "application/json",
};

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

/**
 * Serve a static file from the UI dist directory.
 * Returns null if the file doesn't exist.
 */
async function serveStatic(
  uiRelPath: string
): Promise<Response | null> {
  const filePath = path.join(UI_DIST, uiRelPath);

  // Prevent directory traversal.
  if (!filePath.startsWith(UI_DIST)) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const data = await fs.readFile(filePath);
    const ct = mimeFor(filePath);
    const headers: Record<string, string> = { "Content-Type": ct };

    // Long-lived cache for hashed assets; no-cache for HTML.
    if (ct.includes("html")) {
      headers["Cache-Control"] = "no-cache";
    } else if (
      path.basename(filePath).match(/\.[a-f0-9]{8,}\.(js|css|wasm)$/)
    ) {
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    }

    // T10: static UI responses must carry COOP/COEP so the page becomes
    // cross-origin-isolated and the WASM rayon thread pool can spin up.
    // Elysia's `onBeforeHandle` sets these on `set.headers` but when we
    // return a raw `Response` it doesn't always merge — set them directly
    // here so every file response has them.
    headers["Cross-Origin-Opener-Policy"] = "same-origin";
    headers["Cross-Origin-Embedder-Policy"] = "require-corp";

    return new Response(data, { status: 200, headers });
  } catch {
    return null;
  }
}

/**
 * Elysia plugin that mounts the static UI handler.
 *
 * This MUST be registered AFTER all /api/* routes so that API routes win.
 */
export const staticUiPlugin = new Elysia()
  .get("/*", async ({ request, set }) => {
    const url = new URL(request.url);
    let uiPath = url.pathname;

    // In dev mode: proxy to Angular dev server.
    if (IS_DEV) {
      const target = DEV_ORIGIN + uiPath + (url.search ?? "");
      console.debug(`[static] DEV proxy → ${target}`);
      const proxyResp = await fetch(target, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
      }).catch((e) => {
        console.error("[static] dev proxy error:", e.message);
        return null;
      });
      if (!proxyResp) {
        set.status = 502;
        return { error: "Angular dev server not reachable", tip: `Start it with: cd src/web && ng serve maple-self-hosted --port 4201` };
      }
      // T10: proxied responses from `ng serve` don't carry COOP/COEP. Clone
      // with the isolation headers added so dev-mode threading works too.
      const proxyHeaders = new Headers(proxyResp.headers);
      proxyHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
      proxyHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");
      return new Response(proxyResp.body, {
        status: proxyResp.status,
        statusText: proxyResp.statusText,
        headers: proxyHeaders,
      });
    }

    // Production: serve from dist.
    // Strip leading slash.
    if (uiPath === "/" || uiPath === "") {
      uiPath = "/index.html";
    }

    // Check if dist exists; warn once if not.
    if (!_distExists && !(await checkDist())) {
      set.status = 503;
      return {
        error: "UI bundle not built",
        tip: "Run: cd src/web && ng build maple-self-hosted --configuration=production",
        dist_path: UI_DIST,
      };
    }

    // Try to serve the exact path first.
    const exact = await serveStatic(uiPath);
    if (exact) return exact;

    // SPA fallback: serve index.html for any unmatched path.
    const indexHtml = await serveStatic("/index.html");
    if (indexHtml) return indexHtml;

    set.status = 404;
    return { error: "UI index.html not found in " + UI_DIST };
  });

// One-time dist availability check.
let _distExists: boolean | null = null;

async function checkDist(): Promise<boolean> {
  if (_distExists !== null) return _distExists;
  try {
    await fs.access(path.join(UI_DIST, "index.html"));
    _distExists = true;
    console.log("[static] UI dist found at", UI_DIST);
  } catch {
    _distExists = false;
    console.warn("[static] UI dist NOT found at", UI_DIST);
  }
  return _distExists;
}

// Eagerly check dist availability at module load time.
checkDist();
