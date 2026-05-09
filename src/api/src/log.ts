/**
 * Structured logger for the Maple API.
 *
 * Wraps pino with project-specific defaults:
 *
 *   - Pretty-prints to stdout when NODE_ENV !== "production".
 *   - Emits JSON to stdout otherwise (production / Docker).
 *   - Honours `MAPLE_LOG_LEVEL` (default `"info"`).
 *   - Exposes a `child(component)` helper so each module can tag its
 *     emissions with a stable component name (e.g. `"server"`,
 *     `"indexer:exif"`). The component is bound as a base field so it
 *     appears on every record without per-call boilerplate.
 *
 * Usage:
 *
 *     import { log } from "../log.ts";
 *     const l = log.child("indexer:exif");
 *     l.warn({ absPath, err }, "exifr failed");
 *
 * Replaces ad-hoc `console.log/.warn/.error/.debug` calls scattered
 * through the API. Existing JSON-shaped logs (e.g.
 * `console.warn(JSON.stringify({stage, id, msg}))`) become
 * `logger.warn({stage, id}, msg)`.
 *
 * Implementation note — pretty mode uses pino-pretty as a sync transform
 * stream rather than the `transport` option. The `transport` API spawns
 * a worker thread (via `thread-stream`) that keeps the Bun event loop
 * alive after tests finish, hanging `bun test`. The sync stream stays in
 * the main thread so the test process exits cleanly.
 *
 * Deploy note — `pino-pretty` lives in devDependencies because production
 * doesn't pretty-print. The import is therefore dynamic + try/catch so a
 * `bun install --production` deploy (which skips devDeps) doesn't crash
 * at module load when `NODE_ENV` is unset. If the package can't be
 * resolved we fall through to plain JSON, which is the right shape for
 * any log-collection pipeline.
 */

import pino, { type Logger } from "pino";

const LEVEL = process.env.MAPLE_LOG_LEVEL ?? "info";
const IS_PROD = process.env.NODE_ENV === "production";

const baseOptions = {
  level: LEVEL,
};

async function buildPrettyStream(): Promise<NodeJS.WritableStream | null> {
  if (IS_PROD) return null;
  try {
    // Dynamic import (resolves at runtime) so the static module graph
    // doesn't require pino-pretty in production.
    const mod = await import("pino-pretty");
    const pinoPretty = (mod.default ?? mod) as unknown as (
      opts: object,
    ) => NodeJS.WritableStream;
    return pinoPretty({
      colorize: true,
      translateTime: "HH:MM:ss.l",
      ignore: "pid,hostname",
      messageFormat: "{component} {msg}",
      sync: true,
    });
  } catch {
    // pino-pretty isn't installed (prod deploy without devDeps, or env
    // forgot to set NODE_ENV=production). Fall through to JSON logging
    // — same as IS_PROD === true.
    return null;
  }
}

const prettyStream = await buildPrettyStream();
const logger: Logger = prettyStream
  ? pino(baseOptions, prettyStream)
  : pino(baseOptions);

/**
 * Singleton root logger. Prefer `child(component)` over the root for
 * per-module logging so the `component` field is set consistently.
 */
export { logger };

/**
 * Create a child logger bound to a stable `component` name. The name
 * shows up on every record so logs are searchable by subsystem.
 *
 * Captures pino's native `.child()` BEFORE we wrap it on the default
 * export. Without this snapshot the wrapper below would overwrite
 * `logger.child`, and a subsequent call would recurse into itself
 * forever (the bug found via `bun test`'s hung process — see commit
 * history for the fix).
 */
const pinoChild = logger.child.bind(logger);

export function child(component: string): Logger {
  return pinoChild({ component });
}

/**
 * Default export keeps the import sites compact:
 *
 *     import log from "../log.ts";
 *     const l = log.child("server");
 *
 * Note we deliberately do NOT replace `logger.child` here — the named
 * `child(...)` export is the project-flavoured helper; pino's own
 * `logger.child({...})` keeps its full signature.
 */
export default logger;
