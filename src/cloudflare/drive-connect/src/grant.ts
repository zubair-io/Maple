import { encode } from './ticket';
const encoder = new TextEncoder();
const DOMAIN = 'maple-google-refresh-grant/v1\n';

async function signingKey(secret: string): Promise<CryptoKey> {
	if (encoder.encode(secret).length < 32) throw new Error('Unavailable signing key');
	return crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	);
}
export async function tokenHash(token: string): Promise<string> {
	return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))));
}
/** Durable capability, without token bytes or request state. Routing tickets
 * use a different HMAC domain and cannot authorize token renewal. */
export async function issueRelayGrant(
	refreshToken: string,
	clientId: string,
	secret: string,
): Promise<string> {
	const payload = encode(
		JSON.stringify({
			version: 1,
			purpose: 'google-refresh',
			clientId,
			refreshTokenHash: await tokenHash(refreshToken),
		}),
	);
	const signature = await crypto.subtle.sign(
		'HMAC',
		await signingKey(secret),
		encoder.encode(DOMAIN + payload),
	);
	return payload + '.' + encode(new Uint8Array(signature));
}
function decoded(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid grant');
	return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (character) =>
		character.charCodeAt(0),
	);
}
export async function verifyRelayGrant(
	grant: unknown,
	refreshToken: string,
	clientId: string,
	secret: string,
): Promise<void> {
	if (typeof grant !== 'string' || grant.length > 1024) throw new Error('Invalid grant');
	const parts = grant.split('.');
	if (
		parts.length !== 2 ||
		!(await crypto.subtle.verify(
			'HMAC',
			await signingKey(secret),
			decoded(parts[1]),
			encoder.encode(DOMAIN + parts[0]),
		))
	)
		throw new Error('Invalid grant');
	const payload: unknown = JSON.parse(
		new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(decoded(parts[0])),
	);
	if (!payload || typeof payload !== 'object' || Array.isArray(payload))
		throw new Error('Invalid grant');
	const fields = payload as Record<string, unknown>;
	if (
		Object.keys(fields).length !== 4 ||
		fields['version'] !== 1 ||
		fields['purpose'] !== 'google-refresh' ||
		fields['clientId'] !== clientId ||
		fields['refreshTokenHash'] !== (await tokenHash(refreshToken))
	)
		throw new Error('Invalid grant');
}
