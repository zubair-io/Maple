import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		// Scope to this Worker's own test directory. Without this, vitest's
		// default recursive glob also picks up ssr/test/*.spec.ts — a
		// separate Worker package one level down with its own
		// package.json/vitest.config.mts/bindings (#2474) — and runs those
		// specs against *this* config's bindings (JWT_SECRET,
		// ORIGIN_API_BASE_URL), which the ssr Worker's handler doesn't read,
		// so every request it makes throws "Invalid URL string" instead of
		// hitting the mocked origin.
		include: ['test/**/*.spec.ts'],
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					bindings: {
						// JWT_SECRET is a Worker secret (never in wrangler.jsonc, never
						// committed) — tests need a stand-in value, injected here
						// rather than via a gitignored .dev.vars so CI needs no extra
						// setup.
						JWT_SECRET: 'test-secret-not-for-production-only',
						// Overrides the placeholder production value in
						// wrangler.jsonc with a host the tests' fetchMock intercepts.
						ORIGIN_API_BASE_URL: 'https://origin.test',
					},
				},
			},
		},
	},
});
