import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
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
