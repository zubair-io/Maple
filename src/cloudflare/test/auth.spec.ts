import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { hasImageCapability, verifyBearer } from '../src/auth';

const SECRET = 'test-secret-not-for-production-only';
const secretKey = new TextEncoder().encode(SECRET);

function capabilityToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '');
}

async function sign(claims: Record<string, unknown>, expiresInSeconds: number): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT(claims)
		.setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
		.setSubject('user-1')
		.setIssuedAt(now)
		.setExpirationTime(now + expiresInSeconds)
		.sign(secretKey);
}

describe('verifyBearer', () => {
	it('accepts a validly-signed, unexpired token', async () => {
		const token = await sign({ email: 'a@b.c', role: 'owner' }, 900);
		expect(await verifyBearer(`Bearer ${token}`, SECRET)).toBe(true);
	});

	it('rejects a missing Authorization header', async () => {
		expect(await verifyBearer(null, SECRET)).toBe(false);
	});

	it('rejects a header that is not a Bearer token', async () => {
		expect(await verifyBearer('Basic abc123', SECRET)).toBe(false);
	});

	it('rejects a token signed with a different secret', async () => {
		const token = await sign({ email: 'a@b.c', role: 'owner' }, 900);
		expect(await verifyBearer(`Bearer ${token}`, 'a-completely-different-secret')).toBe(false);
	});

	it('rejects an expired token', async () => {
		const token = await sign({ email: 'a@b.c', role: 'owner' }, -60);
		expect(await verifyBearer(`Bearer ${token}`, SECRET)).toBe(false);
	});

	it('rejects a malformed token', async () => {
		expect(await verifyBearer('Bearer not-a-jwt', SECRET)).toBe(false);
	});

	it('rejects an alg:none forged token', async () => {
		const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
		const payload = btoa(
			JSON.stringify({ sub: 'user-1', role: 'owner', exp: Math.floor(Date.now() / 1000) + 900 }),
		);
		const forged = `${header}.${payload}.`;
		expect(await verifyBearer(`Bearer ${forged}`, SECRET)).toBe(false);
	});
});

describe('hasImageCapability', () => {
	it('recognizes the 32-byte base64url capability format', () => {
		const url = new URL('https://maple.test/api/thumb/photos/a.jpg');
		url.searchParams.set('token', capabilityToken());
		expect(hasImageCapability(url)).toBe(true);
	});

	it('rejects missing, short, and non-base64url query values', () => {
		expect(hasImageCapability(new URL('https://maple.test/api/thumb/photos/a.jpg'))).toBe(false);
		expect(
			hasImageCapability(new URL('https://maple.test/api/thumb/photos/a.jpg?token=short')),
		).toBe(false);
		expect(
			hasImageCapability(
				new URL(
					'https://maple.test/api/thumb/photos/a.jpg?token=abcdefghijklmnopqrstuvwxyzABCDEFGH+12345678',
				),
			),
		).toBe(false);
	});
});
