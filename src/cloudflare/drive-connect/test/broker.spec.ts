import { env } from 'cloudflare:workers';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { REDIRECT_URI, SCOPE, signTicket, encode } from '../src/ticket';
import { issueRelayGrant, verifyRelayGrant } from '../src/grant';

const verifier = 'v'.repeat(64);
const refreshToken = 'google-refresh-token';
const fields = {
	nonce: 'n'.repeat(43),
	clientId: '12345678-managed.apps.googleusercontent.com',
	returnUrl: 'https://photos.lan/api/cloud-backup/google/callback',
};
const call = (path: string, body?: unknown, bindings = env, headers: Record<string, string> = {}) =>
	worker.fetch(
		new Request(`https://mapleeditor.com/api/connect/google-drive/${path}`, {
			method: body === undefined ? 'GET' : 'POST',
			headers: { 'content-type': 'application/json', ...headers },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
		bindings,
	);
async function exchangeInput() {
	const challenge = encode(
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
	);
	const { ticket } = await signTicket({ ...fields, challenge }, env.RELAY_SIGNING_KEY);
	return { ticket, code: 'google-authorization-code', verifier };
}
async function refreshInput(token = refreshToken) {
	return {
		refreshToken: token,
		relayGrant: await issueRelayGrant(token, env.GOOGLE_CLIENT_ID, env.RELAY_SIGNING_KEY),
	};
}
const fetchMock = vi.fn<typeof fetch>();
let expectedRequests = 0;
function googleReply(body: unknown, status = 200, verify?: (parameters: URLSearchParams) => void) {
	expectedRequests += 1;
	fetchMock.mockImplementationOnce(async (url, init) => {
		expect(String(url)).toBe('https://oauth2.googleapis.com/token');
		expect(init?.method).toBe('POST');
		expect(init?.redirect).toBe('error');
		expect(new Headers(init?.headers).get('content-type')).toBe(
			'application/x-www-form-urlencoded',
		);
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		const parameters = new URLSearchParams(String(init?.body));
		expect(parameters.get('client_id')).toBe(env.GOOGLE_CLIENT_ID);
		expect(parameters.get('client_secret')).toBe(env.GOOGLE_CLIENT_SECRET);
		verify?.(parameters);
		return Response.json(body, { status });
	});
}
const tokens = {
	access_token: 'google-access-token',
	token_type: 'Bearer',
	expires_in: 3600,
	refresh_token: refreshToken,
	scope: SCOPE,
};
beforeEach(() => {
	expectedRequests = 0;
	fetchMock.mockReset().mockRejectedValue(new Error('Unregistered upstream request'));
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
	expect(fetchMock.mock.calls).toHaveLength(expectedRequests);
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it('advertises only fixed managed client metadata and fails closed without either credential', async () => {
	expect(await (await call('config')).json()).toEqual({
		clientId: env.GOOGLE_CLIENT_ID,
		redirectUri: REDIRECT_URI,
		scope: SCOPE,
		available: true,
	});
	for (const bindings of [
		{ ...env, GOOGLE_CLIENT_ID: '' },
		{ ...env, GOOGLE_CLIENT_SECRET: '' },
		{ ...env, GOOGLE_CLIENT_SECRET: '   ' },
		{ ...env, RELAY_SIGNING_KEY: '' },
	]) {
		const response = await call('config', undefined, bindings);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			clientId: null,
			redirectUri: REDIRECT_URI,
			scope: SCOPE,
			available: false,
		});
	}
});
it('exchanges a bound PKCE code with Worker credentials and returns only required token fields', async () => {
	googleReply(
		{ ...tokens, id_token: 'omit-id-token', debug_secret: 'omit-extra-secret' },
		200,
		(parameters) => {
			expect(parameters.get('grant_type')).toBe('authorization_code');
			expect(parameters.get('redirect_uri')).toBe(REDIRECT_URI);
			expect(parameters.get('code')).toBe('google-authorization-code');
			expect(parameters.get('code_verifier')).toBe(verifier);
			expect([...parameters.keys()].sort()).toEqual([
				'client_id',
				'client_secret',
				'code',
				'code_verifier',
				'grant_type',
				'redirect_uri',
			]);
		},
	);
	const response = await call('exchange', await exchangeInput());
	expect(response.status).toBe(200);
	const result = (await response.json()) as typeof tokens & {
		relayGrant: string;
	};
	expect(result).toEqual({ ...tokens, relayGrant: expect.any(String) });
	await expect(
		verifyRelayGrant(result.relayGrant, refreshToken, env.GOOGLE_CLIENT_ID, env.RELAY_SIGNING_KEY),
	).resolves.toBeUndefined();
	const payload = JSON.parse(
		atob(result.relayGrant.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')),
	);
	expect(Object.keys(payload).sort()).toEqual([
		'clientId',
		'purpose',
		'refreshTokenHash',
		'version',
	]);
	expect(JSON.stringify(payload)).not.toContain(refreshToken);
	expect(response.headers.get('cache-control')).toContain('no-store');
	expect(response.headers.get('referrer-policy')).toBe('no-referrer');
});
it('renews without rotation and keeps a restart-valid hash-bound grant', async () => {
	const input = await refreshInput();
	googleReply(
		{ access_token: 'new-access', token_type: 'Bearer', expires_in: 3600 },
		200,
		(parameters) => {
			expect(parameters.get('grant_type')).toBe('refresh_token');
			expect(parameters.get('refresh_token')).toBe(refreshToken);
			expect([...parameters.keys()].sort()).toEqual([
				'client_id',
				'client_secret',
				'grant_type',
				'refresh_token',
			]);
		},
	);
	const response = await call('refresh', input, { ...env });
	const result = (await response.json()) as { relayGrant: string };
	expect(response.status).toBe(200);
	expect(result).toEqual({
		access_token: 'new-access',
		token_type: 'Bearer',
		expires_in: 3600,
		relayGrant: input.relayGrant,
	});
});
it('binds a renewed grant to the rotated refresh token', async () => {
	googleReply({ ...tokens, refresh_token: 'rotated-refresh' });
	const response = await call('refresh', await refreshInput());
	const result = (await response.json()) as {
		relayGrant: string;
		refresh_token: string;
	};
	expect(result.refresh_token).toBe('rotated-refresh');
	await expect(
		verifyRelayGrant(
			result.relayGrant,
			'rotated-refresh',
			env.GOOGLE_CLIENT_ID,
			env.RELAY_SIGNING_KEY,
		),
	).resolves.toBeUndefined();
	await expect(
		verifyRelayGrant(result.relayGrant, refreshToken, env.GOOGLE_CLIENT_ID, env.RELAY_SIGNING_KEY),
	).rejects.toThrow();
});
it.each(['exchange', 'refresh'])(
	'refuses any browser Origin on %s, including same origin and empty Origin',
	async (path) => {
		const input = path === 'exchange' ? await exchangeInput() : await refreshInput();
		for (const Origin of ['https://mapleeditor.com', 'https://evil.test', ''])
			expect((await call(path, input, env, { Origin })).status).toBe(403);
	},
);
it('rejects wrong PKCE, client, expiration and tampering before reaching Google', async () => {
	const input = await exchangeInput();
	const decoded = await signTicket(
		{
			...fields,
			clientId: '12345678-other.apps.googleusercontent.com',
			challenge: 'c'.repeat(43),
		},
		env.RELAY_SIGNING_KEY,
	);
	for (const invalid of [
		{ ...input, verifier: 'w'.repeat(64) },
		{ ...input, ticket: decoded.ticket },
		{ ...input, ticket: input.ticket.slice(0, -2) + 'aa' },
		{ ...input, verifier: 'short' },
	])
		expect((await call('exchange', invalid)).status).toBe(403);
	const now = Date.now();
	vi.spyOn(Date, 'now').mockReturnValue(now + 600001);
	expect((await call('exchange', input)).status).toBe(403);
});
it('rejects token substitution, wrong clients, key rotation, routing-ticket replay and grant tampering', async () => {
	const input = await refreshInput();
	const ticket = await exchangeInput();
	for (const invalid of [
		{ ...input, refreshToken: 'another-refresh' },
		{ ...input, relayGrant: input.relayGrant.slice(0, -2) + 'aa' },
		{ ...input, relayGrant: ticket.ticket },
		{
			...input,
			relayGrant: await issueRelayGrant(
				refreshToken,
				'12345678-other.apps.googleusercontent.com',
				env.RELAY_SIGNING_KEY,
			),
		},
		{
			...input,
			relayGrant: await issueRelayGrant(
				refreshToken,
				env.GOOGLE_CLIENT_ID,
				'rotated-signing-key-at-least-thirty-two-bytes',
			),
		},
	])
		expect((await call('refresh', invalid)).status).toBe(403);
});
it.each(['invalid_grant', 'invalid_client', 'unauthorized_client', 'custom_sensitive_token_error'])(
	'redacts provider error %s and never logs token-bearing details',
	async (error) => {
		const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
		googleReply(
			{
				error,
				error_description: 'sensitive-refresh-token client-secret authorization-code',
				tokens,
			},
			400,
		);
		const response = await call('refresh', await refreshInput());
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error:
				error === 'invalid_grant'
					? 'invalid_grant'
					: error === 'invalid_client' || error === 'unauthorized_client'
						? 'invalid_client'
						: 'invalid_request',
		});
		expect(logs).not.toHaveBeenCalled();
	},
);
it.each([429, 500, 503])('reports upstream %s as a fixed transient error', async (status) => {
	googleReply({ error: 'private-upstream-response', error_description: refreshToken }, status);
	const response = await call('refresh', await refreshInput());
	expect(response.status).toBe(502);
	expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
});
it('bounds and redacts oversized upstream JSON', async () => {
	googleReply({ token: 'secret'.repeat(4000) });
	const response = await call('refresh', await refreshInput());
	expect(response.status).toBe(502);
	expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
});
it.each([
	{ ...tokens, scope: 'https://www.googleapis.com/auth/drive' },
	{ ...tokens, expires_in: 0 },
	{ ...tokens, token_type: 'Other' },
	{ ...tokens, access_token: '' },
])('rejects invalid token reply %#', async (reply) => {
	googleReply(reply);
	const response = await call('exchange', await exchangeInput());
	expect(response.status).toBe(502);
	expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
});
it('requires an initial refresh token rather than returning an unusable managed connection', async () => {
	googleReply({
		access_token: 'access',
		token_type: 'Bearer',
		expires_in: 3600,
	});
	const response = await call('exchange', await exchangeInput());
	expect(response.status).toBe(400);
	expect(await response.json()).toEqual({ error: 'invalid_grant' });
});
it('refuses caller-selected credentials, endpoints, bad JSON and oversized request bodies', async () => {
	const input = await exchangeInput();
	for (const invalid of [
		{ ...input, clientSecret: 'caller-secret' },
		{ ...input, endpoint: 'https://evil.test' },
		{ ...input, code: 'a'.repeat(9000) },
		{ ...input, code: 'control\u0000code' },
	])
		expect((await call('exchange', invalid)).status).toBe(400);
	const response = await worker.fetch(
		new Request('https://mapleeditor.com/api/connect/google-drive/refresh', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{',
		}),
		env,
	);
	expect(response.status).toBe(400);
});
it('keeps BYO callback relay working while managed credentials are absent', async () => {
	const bindings = { ...env, GOOGLE_CLIENT_SECRET: '' };
	const input = await exchangeInput();
	expect((await call('exchange', input, bindings)).status).toBe(503);
	expect((await call('validate', { ticket: input.ticket }, bindings)).status).toBe(200);
	expect(
		(
			await call(
				`callback?code=code&state=${encodeURIComponent(input.ticket)}`,
				undefined,
				bindings,
			)
		).status,
	).toBe(303);
});

it('refresh grants remain valid after routing tickets expire and across process clock changes', async () => {
	const input = await refreshInput();
	vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 365 * 86400000);
	googleReply({
		access_token: 'renewed-after-restart',
		token_type: 'Bearer',
		expires_in: 3600,
	});
	expect((await call('refresh', input, { ...env })).status).toBe(200);
	expect(
		(
			await call('refresh', input, {
				...env,
				RELAY_SIGNING_KEY: 'new-key-at-least-thirty-two-bytes-long',
			})
		).status,
	).toBe(403);
});

it('cancels oversized request and Google response streams before retaining further chunks', async () => {
	let requestCancelled = false;
	const requestBody = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new Uint8Array(9000));
		},
		cancel() {
			requestCancelled = true;
		},
	});
	const response = await worker.fetch(
		new Request('https://mapleeditor.com/api/connect/google-drive/refresh', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: requestBody,
		}),
		env,
	);
	expect(response.status).toBe(400);
	expect(requestCancelled).toBe(true);
	let upstreamCancelled = false;
	expectedRequests += 1;
	fetchMock.mockResolvedValueOnce(
		new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					controller.enqueue(new Uint8Array(17000));
				},
				cancel() {
					upstreamCancelled = true;
				},
			}),
		),
	);
	expect((await call('refresh', await refreshInput())).status).toBe(502);
	expect(upstreamCancelled).toBe(true);
});
it('sanitizes network and malformed UTF-8 upstream failures without returning input credentials', async () => {
	for (const reply of [
		new Response(new Uint8Array([255])),
		new Error('leaked-access-token refresh-token client-secret'),
	]) {
		expectedRequests += 1;
		if (reply instanceof Response) fetchMock.mockResolvedValueOnce(reply);
		else fetchMock.mockRejectedValueOnce(reply);
		const response = await call('refresh', await refreshInput());
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
	}
});
it.each([{ version: 2 }, { purpose: 'routing-ticket' }, { extra: 'unexpected' }])(
	'rejects even correctly signed grants with wrong capability fields %#',
	async (change) => {
		const input = await refreshInput();
		const original = JSON.parse(
			atob(input.relayGrant.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')),
		);
		const payload = encode(JSON.stringify({ ...original, ...change }));
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(env.RELAY_SIGNING_KEY),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		);
		const signature = encode(
			new Uint8Array(
				await crypto.subtle.sign(
					'HMAC',
					key,
					new TextEncoder().encode('maple-google-refresh-grant/v1\n' + payload),
				),
			),
		);
		expect(
			(
				await call('refresh', {
					...input,
					relayGrant: payload + '.' + signature,
				})
			).status,
		).toBe(403);
	},
);
