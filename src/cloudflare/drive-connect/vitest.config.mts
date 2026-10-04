import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			miniflare: {
				bindings: {
					RELAY_SIGNING_KEY: 'test-only-secret-at-least-thirty-two-bytes-long',
				},
			},
		}),
	],
});
