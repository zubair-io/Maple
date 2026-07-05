// Augments the generated `Env` interface (worker-configuration.d.ts, from
// `wrangler types`) with the JWT_SECRET binding. Secrets are never declared
// in wrangler.jsonc (they're pushed via `wrangler secret put`, not
// committed), so `wrangler types` can't infer this one — declared by hand
// instead. TypeScript merges this with the generated `interface Env` since
// both are global ambient declarations (no import/export in either file).
interface Env {
	/** HS256 signing secret shared with the Maple API server. Set via
	 * `wrangler secret put JWT_SECRET` — see wrangler.jsonc. */
	JWT_SECRET: string;
}
