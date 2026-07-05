/**
 * The port this Bun/Elysia process listens on. Extracted from `index.ts` so
 * other modules (e.g. `network/network-config.repo.ts`) can read it without
 * importing `index.ts` itself — that module has top-level side effects
 * (`start()` runs when it's the process entry point) that must never fire
 * from a plain module import.
 */
export const SERVER_PORT = Number(process.env.PORT ?? 3000);
