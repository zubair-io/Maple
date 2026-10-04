import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { REDIRECT_URI, RETURN_PAGE, verifyTicket } from '../src/ticket';

const fields = {
	nonce: 'n'.repeat(43),
	challenge: 'c'.repeat(43),
	clientId: '12345678-example.apps.googleusercontent.com',
	returnUrl: 'https://photos.lan:3443/api/cloud-backup/google/callback',
};
const call = (path: string, body?: unknown, method = body ? 'POST' : 'GET', headers = {}) =>
	worker.fetch(
		new Request(`https://mapleeditor.com/api/connect/google-drive/${path}`, {
			method,
			headers: { 'content-type': 'application/json', ...headers },
			...(body ? { body: JSON.stringify(body) } : {}),
		}),
		env,
	);
const start = async () => (await (await call('start', fields)).json()) as { ticket: string };

describe('callback-only Google relay', () => {
	it('binds callback, client, nonce and PKCE challenge without a verifier or token', async () => {
		const { ticket } = await start();
		const response = await call('validate', { ticket });
		expect(await response.json()).toEqual({
			...fields,
			version: 1,
			redirectUri: REDIRECT_URI,
			expiresAt: expect.any(Number),
			scope: 'https://www.googleapis.com/auth/drive.file',
		});
		expect(response.headers.get('cache-control')).toContain('no-store');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
	});
	it('moves a code into the static return fragment, preserving the exact signed state', async () => {
		const { ticket } = await start();
		const response = await call(`callback?code=google-code&state=${encodeURIComponent(ticket)}`);
		const url = new URL(response.headers.get('location')!);
		expect(url.origin + url.pathname).toBe(RETURN_PAGE);
		expect(url.searchParams.has('code')).toBe(false);
		expect(JSON.parse(atob(url.hash.slice(1).replace(/-/g, '+').replace(/_/g, '/')))).toEqual({
			ticket,
			code: 'google-code',
		});
	});
	it('returns denial through the same fragment flow', async () => {
		const { ticket } = await start();
		expect((await call(`callback?error=access_denied&state=${ticket}`)).status).toBe(303);
	});
	it('rejects expired and tampered routing tickets', async () => {
		const { ticket } = await start();
		expect((await call('validate', { ticket: ticket.slice(0, -2) + 'aa' })).status).toBe(400);
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600001);
		expect((await call('validate', { ticket })).status).toBe(400);
		vi.restoreAllMocks();
	});
	it.each([
		'javascript:alert(1)',
		'http://photos.lan/api/cloud-backup/google/callback',
		'https://photos.lan/wrong',
		'https://user:pass@photos.lan/api/cloud-backup/google/callback',
		'https://photos.lan/api/cloud-backup/google/callback?code=1',
	])('rejects unsafe callback %s', async (returnUrl) => {
		expect((await call('start', { ...fields, returnUrl })).status).toBe(400);
	});
	it('permits explicit loopback HTTP for local development', async () => {
		expect(
			(
				await call('start', {
					...fields,
					returnUrl: 'http://127.0.0.1:3000/api/cloud-backup/google/callback',
				})
			).status,
		).toBe(200);
	});
	it('refuses secrets, malformed and oversized bodies and cross-origin browser calls', async () => {
		expect((await call('start', { ...fields, clientSecret: 'secret' })).status).toBe(400);
		expect((await call('start', { ...fields, nonce: 'short' })).status).toBe(400);
		expect((await call('validate', { ticket: 'a'.repeat(9000) })).status).toBe(400);
		expect((await call('start', fields, 'POST', { Origin: 'https://evil.test' })).status).toBe(403);
	});
	it('never falls back to SPA HTML for unknown routes or methods', async () => {
		expect((await call('unknown')).status).toBe(404);
		expect((await call('start', undefined, 'GET')).status).toBe(405);
	});
	it('rejects duplicate callback parameters and simultaneous code/error', async () => {
		const { ticket } = await start();
		expect((await call(`callback?state=${ticket}&code=a&code=b`)).status).toBe(400);
		expect((await call(`callback?state=${ticket}&code=a&error=access_denied`)).status).toBe(400);
		await expect(
			verifyTicket(ticket, 'different-key-that-is-at-least-thirty-two-bytes'),
		).rejects.toThrow();
	});
});
