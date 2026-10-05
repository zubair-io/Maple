import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const compatibilityDate = JSON.parse(config.match(/"compatibility_date"\s*:\s*("[^"]+")/)[1]);
const compatibilityFlags = JSON.parse(config.match(/"compatibility_flags"\s*:\s*(\[[^\]]+\])/)[1]);
const { outputFiles } = await build({
	entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'browser',
});
const clientId = '12345678-test.apps.googleusercontent.com';
const verifier = 'v'.repeat(64);
const tokenEndpoint = 'https://oauth2.googleapis.com/token';
const scope = 'https://www.googleapis.com/auth/drive.file';

async function withWorker(upstream, run) {
	const worker = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: outputFiles[0].text,
			compatibilityDate,
			compatibilityFlags,
			bindings: {
				RELAY_SIGNING_KEY: 'test-signing-key-over-thirty-two-bytes',
				GOOGLE_CLIENT_ID: clientId,
				GOOGLE_CLIENT_SECRET: 'dummy-test-client-secret',
			},
			outboundService: upstream,
		}),
	);
	const send = (path, body) =>
		worker.dispatchFetch(`https://mapleeditor.com/api/connect/google-drive/${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	try {
		const start = await send('start', {
			nonce: 'n'.repeat(43),
			clientId,
			challenge: createHash('sha256').update(verifier).digest('base64url'),
			returnUrl: 'http://localhost:4321/api/cloud-backup/google/callback',
		});
		assert.equal(start.status, 200);
		const { ticket } = await start.json();
		await run(send, { ticket, code: 'dummy-invalid-code', verifier });
	} finally {
		await worker.dispose();
	}
}

test('real Workers fetch reaches Google and returns a sanitized OAuth rejection', async () => {
	assert.ok(compatibilityFlags.includes('enable_request_signal'));
	let calls = 0;
	await withWorker(
		async (request) => {
			calls += 1;
			assert.equal(request.url, tokenEndpoint);
			const body = new URLSearchParams(await request.text());
			assert.equal(body.get('client_id'), clientId);
			assert.equal(body.get('client_secret'), 'dummy-test-client-secret');
			assert.equal(body.get('code_verifier'), verifier);
			return Response.json(
				{ error: 'invalid_grant', error_description: 'Do not expose provider details' },
				{ status: 400 },
			);
		},
		async (send, input) => {
			const response = await send('exchange', input);
			assert.equal(response.status, 400);
			assert.deepEqual(await response.json(), { error: 'invalid_grant' });
		},
	);
	assert.equal(calls, 1);
});

test('real Workers fetch never follows a token-endpoint redirect with credentials', async () => {
	let calls = 0;
	await withWorker(
		async (request) => {
			calls += 1;
			assert.equal(request.url, tokenEndpoint);
			return new Response('Do not expose redirect contents', {
				status: 302,
				headers: { Location: 'https://foreign.example/token' },
			});
		},
		async (send, input) => {
			const response = await send('exchange', input);
			assert.equal(response.status, 502);
			assert.deepEqual(await response.json(), { error: 'temporarily_unavailable' });
		},
	);
	assert.equal(calls, 1);
});

test('real Workers fetch handles a successful token response and bound renewal', async () => {
	const grants = [];
	await withWorker(
		async (request) => {
			assert.equal(request.url, tokenEndpoint);
			const body = new URLSearchParams(await request.text());
			grants.push(body.get('grant_type'));
			return Response.json({
				access_token: 'dummy-access-token',
				token_type: 'Bearer',
				expires_in: 3600,
				refresh_token: 'dummy-refresh-token',
				scope,
			});
		},
		async (send, input) => {
			const exchanged = await send('exchange', input);
			assert.equal(exchanged.status, 200);
			const tokens = await exchanged.json();
			assert.equal(typeof tokens.relayGrant, 'string');
			const renewed = await send('refresh', {
				refreshToken: tokens.refresh_token,
				relayGrant: tokens.relayGrant,
			});
			assert.equal(renewed.status, 200);
			assert.equal((await renewed.json()).access_token, 'dummy-access-token');
		},
	);
	assert.deepEqual(grants, ['authorization_code', 'refresh_token']);
});
