import {
	encode,
	HOSTS,
	RETURN_PAGE,
	SCOPE,
	signTicket,
	ticketFields,
	verifyTicket,
} from './ticket';

import { json, HEADERS, boundedJson } from './http';
import { brokerConfig, brokerRequest } from './broker';

const PREFIX = '/api/connect/google-drive';
export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.protocol !== 'https:' || !HOSTS.has(url.hostname))
			return json({ error: 'Unknown host' }, 404);
		const allowedMethod = [`${PREFIX}/callback`, `${PREFIX}/config`].includes(url.pathname)
			? 'GET'
			: [
						`${PREFIX}/start`,
						`${PREFIX}/validate`,
						`${PREFIX}/exchange`,
						`${PREFIX}/refresh`,
				  ].includes(url.pathname)
				? 'POST'
				: null;
		if (!allowedMethod) return json({ error: 'Not found' }, 404);
		if (request.method !== allowedMethod)
			return new Response(null, {
				status: 405,
				headers: { ...HEADERS, Allow: allowedMethod },
			});
		if (url.pathname === `${PREFIX}/config`) return brokerConfig(env);
		if ([`${PREFIX}/exchange`, `${PREFIX}/refresh`].includes(url.pathname))
			return brokerRequest(
				url.pathname.endsWith('/exchange') ? 'exchange' : 'refresh',
				request,
				env,
			);
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
