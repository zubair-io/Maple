import {
	encode,
	HOSTS,
	RETURN_PAGE,
	SCOPE,
	signTicket,
	ticketFields,
	verifyTicket,
} from './ticket';

const PREFIX = '/api/connect/google-drive';
const HEADERS = {
	'Cache-Control': 'no-store, no-transform',
	'Referrer-Policy': 'no-referrer',
	'X-Content-Type-Options': 'nosniff',
	'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
	'Cross-Origin-Resource-Policy': 'same-origin',
};
function json(data: unknown, status = 200): Response {
	return Response.json(data, { status, headers: HEADERS });
}
async function boundedJson(request: Request): Promise<Record<string, unknown>> {
	if (!request.headers.get('content-type')?.startsWith('application/json'))
		throw new Error('JSON required');
	const reader = request.body?.getReader();
	if (!reader) throw new Error('Body required');
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			length += value.length;
			if (length > 8192) throw new Error('Body too large');
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	const data: unknown = JSON.parse(
		new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
	);
	if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid request');
	return data as Record<string, unknown>;
}
export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.protocol !== 'https:' || !HOSTS.has(url.hostname))
			return json({ error: 'Unknown host' }, 404);
		const allowedMethod =
			url.pathname === `${PREFIX}/callback`
				? 'GET'
				: [`${PREFIX}/start`, `${PREFIX}/validate`].includes(url.pathname)
					? 'POST'
					: null;
		if (!allowedMethod) return json({ error: 'Not found' }, 404);
		if (request.method !== allowedMethod)
			return new Response(null, {
				status: 405,
				headers: { ...HEADERS, Allow: allowedMethod },
			});
		if (!env.RELAY_SIGNING_KEY) return json({ error: 'Relay unavailable' }, 503);
		// Browsers may only call the relay from its own Hosted origin. Bun's
		// server-to-server start request has no Origin; no instance fetch occurs.
		const origin = request.headers.get('origin');
		if (origin && origin !== url.origin) return json({ error: 'Invalid origin' }, 403);
		try {
			if (url.pathname === `${PREFIX}/start`) {
				const body = await boundedJson(request);
				if (
					Object.keys(body).some(
						(k) => !['nonce', 'clientId', 'challenge', 'returnUrl'].includes(k),
					)
				)
					throw new Error('Invalid fields');
				return json(await signTicket(ticketFields(body), env.RELAY_SIGNING_KEY));
			}
			if (url.pathname === `${PREFIX}/validate`) {
				const body = await boundedJson(request);
				return json({
					...(await verifyTicket(body['ticket'], env.RELAY_SIGNING_KEY)),
					scope: SCOPE,
				});
			}
			if (url.href.length > 12288 || url.searchParams.getAll('state').length !== 1)
				throw new Error('Invalid callback');
			const ticket = url.searchParams.get('state');
			await verifyTicket(ticket, env.RELAY_SIGNING_KEY);
			const code = url.searchParams.get('code');
			const error = url.searchParams.get('error');
			if (
				Boolean(code) === Boolean(error) ||
				url.searchParams.getAll(code ? 'code' : 'error').length !== 1 ||
				(code && (code.length > 4096 || /[\x00-\x20\x7f]/.test(code))) ||
				(error && !/^[a-z_]{1,64}$/.test(error))
			)
				throw new Error('Invalid callback');
			// The code remains in the fragment, never a query to the Azure origin.
			const fragment = encode(JSON.stringify({ ticket, ...(code ? { code } : { error }) }));
			return new Response(null, {
				status: 303,
				headers: {
					...HEADERS,
					Location: `${RETURN_PAGE}?ngsw-bypass=true#${fragment}`,
				},
			});
		} catch {
			return json({ error: 'Invalid or expired connection. Start again from Maple.' }, 400);
		}
	},
} satisfies ExportedHandler<Env>;
