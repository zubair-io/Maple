export const REDIRECT_URI = 'https://mapleeditor.com/api/connect/google-drive/callback';
export const RETURN_PAGE = 'https://mapleeditor.com/connect/google-drive/return';
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const HOSTS = new Set(['mapleeditor.com', 'maple-editor.com', 'mapleaperture.com']);
export const TTL_MS = 10 * 60 * 1000;
const encoder = new TextEncoder();

export interface Ticket {
	version: 1;
	nonce: string;
	clientId: string;
	challenge: string;
	returnUrl: string;
	redirectUri: typeof REDIRECT_URI;
	expiresAt: number;
}

export function encode(value: string | Uint8Array): string {
	const bytes = typeof value === 'string' ? encoder.encode(value) : value;
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}
function decode(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
	return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}
export function validateReturnUrl(value: unknown): string {
	if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid callback URL');
	const url = new URL(value);
	const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
	if (
		(url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== '/api/cloud-backup/google/callback'
	)
		throw new Error('Invalid callback URL');
	return url.href;
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid ticket');
	return value as Record<string, unknown>;
}
export function ticketFields(
	value: unknown,
): Pick<Ticket, 'nonce' | 'clientId' | 'challenge' | 'returnUrl'> {
	const input = object(value);
	if (
		typeof input['nonce'] !== 'string' ||
		!/^[A-Za-z0-9_-]{43}$/.test(input['nonce']) ||
		typeof input['clientId'] !== 'string' ||
		!/^[A-Za-z0-9_-]{8,200}\.apps\.googleusercontent\.com$/.test(input['clientId']) ||
		typeof input['challenge'] !== 'string' ||
		!/^[A-Za-z0-9_-]{43}$/.test(input['challenge'])
	)
		throw new Error('Invalid ticket');
	return {
		nonce: input['nonce'],
		clientId: input['clientId'],
		challenge: input['challenge'],
		returnUrl: validateReturnUrl(input['returnUrl']),
	};
}
async function key(secret: string): Promise<CryptoKey> {
	if (!secret || encoder.encode(secret).length < 32) throw new Error('Relay unavailable');
	return crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	);
}
export async function signTicket(
	fields: ReturnType<typeof ticketFields>,
	secret: string,
): Promise<{ ticket: string; expiresAt: number; redirectUri: string }> {
	const expiresAt = Date.now() + TTL_MS;
	const payload = encode(
		JSON.stringify({
			version: 1,
			...fields,
			redirectUri: REDIRECT_URI,
			expiresAt,
		} satisfies Ticket),
	);
	const signature = await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(payload));
	return {
		ticket: `${payload}.${encode(new Uint8Array(signature))}`,
		expiresAt,
		redirectUri: REDIRECT_URI,
	};
}
export async function verifyTicket(value: unknown, secret: string): Promise<Ticket> {
	if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid ticket');
	const parts = value.split('.');
	if (
		parts.length !== 2 ||
		!(await crypto.subtle.verify(
			'HMAC',
			await key(secret),
			decode(parts[1]),
			encoder.encode(parts[0]),
		))
	)
		throw new Error('Invalid ticket');
	const parsed = object(
		JSON.parse(
			new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(decode(parts[0])),
		),
	);
	const fields = ticketFields(parsed);
	if (
		parsed['version'] !== 1 ||
		parsed['redirectUri'] !== REDIRECT_URI ||
		typeof parsed['expiresAt'] !== 'number' ||
		!Number.isSafeInteger(parsed['expiresAt']) ||
		parsed['expiresAt'] <= Date.now() ||
		parsed['expiresAt'] > Date.now() + TTL_MS
	)
		throw new Error('Expired ticket');
	return {
		version: 1,
		...fields,
		redirectUri: REDIRECT_URI,
		expiresAt: parsed['expiresAt'],
	};
}
