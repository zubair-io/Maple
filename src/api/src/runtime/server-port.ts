/**
 * The port this Bun/Elysia process listens on. Extracted from `index.ts` so
 * other modules (e.g. `network/network-config.repo.ts`) can read it without
 * importing `index.ts` itself — that module has top-level side effects
 * (`start()` runs when it's the process entry point) that must never fire
 * from a plain module import.
 *
 * Falls back to 3000 for anything outside a valid TCP port — an unset,
 * empty, or malformed `PORT` env var would otherwise produce `NaN` (or `0`
 * for `PORT=''`), which `server.listen()` would reject and which
 * `routes/network.ts` would otherwise advertise as an unusable port.
 */
const DEFAULT_PORT = 3000;
const parsed = Number(process.env.PORT ?? DEFAULT_PORT);
export const SERVER_PORT =
  Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : DEFAULT_PORT;
