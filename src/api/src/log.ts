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
 */

import pino, { type Logger } from "pino";
import pinoPretty from "pino-pretty";

const LEVEL = process.env.MAPLE_LOG_LEVEL ?? "info";
const IS_PROD = process.env.NODE_ENV === "production";

const baseOptions = {
  level: LEVEL,
};

const logger: Logger = IS_PROD
  ? pino(baseOptions)
  : pino(
      baseOptions,
      pinoPretty({
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname",
        messageFormat: "{component} {msg}",
        sync: true,
      }),
    );

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
