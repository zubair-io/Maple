import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					bindings: {
						// Overrides the placeholder production value in
						// wrangler.jsonc with a host the tests' fetchMock intercepts.
						ORIGIN_BASE_URL: 'https://origin.test/mapleaperture',
					},
				},
			},
		},
	},
});
