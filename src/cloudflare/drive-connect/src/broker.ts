import { boundedJson, boundedResponseJson, json } from './http';
import { REDIRECT_URI, SCOPE, encode, verifyTicket } from './ticket';
import { issueRelayGrant, verifyRelayGrant } from './grant';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CLIENT_PATTERN = /^[A-Za-z0-9_-]{8,200}\.apps\.googleusercontent\.com$/;
type BrokerErrorCode =
	| 'invalid_request'
	| 'invalid_proof'
	| 'invalid_grant'
	| 'invalid_client'
	| 'temporarily_unavailable'
	| 'broker_unavailable';
class BrokerError extends Error {
	constructor(
		readonly code: BrokerErrorCode,
		readonly status: number,
	) {
		super(code);
	}
}
function managedAvailable(env: Env): boolean {
	return (
		typeof env.GOOGLE_CLIENT_ID === 'string' &&
		CLIENT_PATTERN.test(env.GOOGLE_CLIENT_ID) &&
		typeof env.GOOGLE_CLIENT_SECRET === 'string' &&
		env.GOOGLE_CLIENT_SECRET.trim().length > 0 &&
		env.GOOGLE_CLIENT_SECRET.length <= 2048 &&
		typeof env.RELAY_SIGNING_KEY === 'string' &&
		new TextEncoder().encode(env.RELAY_SIGNING_KEY).length >= 32
	);
}
export function brokerConfig(env: Env): Response {
	const available = managedAvailable(env);
	return json(
		{
			clientId: available ? env.GOOGLE_CLIENT_ID : null,
			redirectUri: REDIRECT_URI,
			scope: SCOPE,
			available,
		},
		available ? 200 : 503,
	);
}
function tokenValue(value: unknown, maximum = 4096): string {
	if (
		typeof value !== 'string' ||
		!value ||
		value.length > maximum ||
		/[\x00-\x20\x7f]/.test(value)
	)
		throw new BrokerError('invalid_request', 400);
	return value;
}
function onlyFields(body: Record<string, unknown>, fields: string[]): void {
	if (Object.keys(body).some((key) => !fields.includes(key)))
		throw new BrokerError('invalid_request', 400);
}
async function exchangeProof(body: Record<string, unknown>, env: Env): Promise<URLSearchParams> {
	onlyFields(body, ['ticket', 'code', 'verifier']);
	const code = tokenValue(body['code']);
	const verifier = tokenValue(body['verifier'], 128);
	if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new BrokerError('invalid_proof', 403);
	try {
		const ticket = await verifyTicket(body['ticket'], env.RELAY_SIGNING_KEY);
		const challenge = encode(
			new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
		);
		if (ticket.clientId !== env.GOOGLE_CLIENT_ID || ticket.challenge !== challenge)
			throw new Error('Invalid proof');
	} catch {
		throw new BrokerError('invalid_proof', 403);
	}
	return new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		code_verifier: verifier,
		redirect_uri: REDIRECT_URI,
	});
}
async function refreshProof(body: Record<string, unknown>, env: Env): Promise<URLSearchParams> {
	onlyFields(body, ['refreshToken', 'relayGrant']);
	const token = tokenValue(body['refreshToken']);
	try {
		await verifyRelayGrant(body['relayGrant'], token, env.GOOGLE_CLIENT_ID, env.RELAY_SIGNING_KEY);
	} catch {
		throw new BrokerError('invalid_proof', 403);
	}
	return new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: token,
	});
}
function providerError(body: Record<string, unknown>, status: number): BrokerError {
	if (body['error'] === 'invalid_grant') return new BrokerError('invalid_grant', 400);
	if (body['error'] === 'invalid_client' || body['error'] === 'unauthorized_client')
		return new BrokerError('invalid_client', 400);
	if (status === 429 || status >= 500) return new BrokerError('temporarily_unavailable', 502);
	return new BrokerError('invalid_request', 400);
}
async function googleTokens(
	parameters: URLSearchParams,
	request: Request,
	env: Env,
): Promise<Record<string, unknown>> {
	parameters.set('client_id', env.GOOGLE_CLIENT_ID);
	parameters.set('client_secret', env.GOOGLE_CLIENT_SECRET);
	try {
		const response = await fetch(TOKEN_ENDPOINT, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: parameters,
			redirect: 'error',
			signal: AbortSignal.any([request.signal, AbortSignal.timeout(30000)]),
		});
		const body = await boundedResponseJson(response, 16384);
		if (!response.ok) throw providerError(body, response.status);
		return body;
	} catch (error) {
		if (error instanceof BrokerError) throw error;
		throw new BrokerError('temporarily_unavailable', 502);
	}
}
async function tokenReply(
	body: Record<string, unknown>,
	previousRefresh: string | undefined,
	env: Env,
): Promise<Response> {
	try {
		const access_token = tokenValue(body['access_token']);
		if (
			body['token_type'] !== 'Bearer' ||
			!Number.isSafeInteger(body['expires_in']) ||
			(body['expires_in'] as number) <= 0 ||
			(body['expires_in'] as number) > 86400
		)
			throw new Error('Invalid token response');
		if (body['scope'] !== undefined && body['scope'] !== SCOPE) throw new Error('Invalid scope');
		const refresh_token =
			body['refresh_token'] === undefined ? previousRefresh : tokenValue(body['refresh_token']);
		if (!refresh_token) throw new BrokerError('invalid_grant', 400);
		const relayGrant = await issueRelayGrant(
			refresh_token,
			env.GOOGLE_CLIENT_ID,
			env.RELAY_SIGNING_KEY,
		);
		return json({
			access_token,
			token_type: 'Bearer',
			expires_in: body['expires_in'],
			...(body['scope'] === SCOPE ? { scope: SCOPE } : {}),
			...(body['refresh_token'] !== undefined ? { refresh_token } : {}),
			relayGrant,
		});
	} catch (error) {
		if (error instanceof BrokerError && error.code === 'invalid_grant') throw error;
		throw new BrokerError('temporarily_unavailable', 502);
	}
}
/** Server-to-server only. Sensitive values live only in this request's stack;
 * no logging, durable bindings, callbacks, or caller-selected upstream URL. */
export async function brokerRequest(
	mode: 'exchange' | 'refresh',
	request: Request,
	env: Env,
): Promise<Response> {
	if (request.headers.has('origin')) return json({ error: 'invalid_request' }, 403);
	if (!managedAvailable(env)) return json({ error: 'broker_unavailable' }, 503);
	try {
		const body = await boundedJson(request).catch(() => {
			throw new BrokerError('invalid_request', 400);
		});
		const parameters =
			mode === 'exchange' ? await exchangeProof(body, env) : await refreshProof(body, env);
		const tokens = await googleTokens(parameters, request, env);
		return await tokenReply(
			tokens,
			mode === 'refresh' ? parameters.get('refresh_token')! : undefined,
			env,
		);
	} catch (error) {
		const safe =
			error instanceof BrokerError ? error : new BrokerError('temporarily_unavailable', 502);
		return json({ error: safe.code }, safe.status);
	}
}
