export const HEADERS = {
	'Cache-Control': 'no-store, no-transform',
	'Referrer-Policy': 'no-referrer',
	'X-Content-Type-Options': 'nosniff',
	'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
	'Cross-Origin-Resource-Policy': 'same-origin',
};
export function json(data: unknown, status = 200): Response {
	return Response.json(data, { status, headers: HEADERS });
}
export async function boundedJson(request: Request): Promise<Record<string, unknown>> {
	if (!request.headers.get('content-type')?.startsWith('application/json'))
		throw new Error('JSON required');
	return boundedResponseJson(request, 8192);
}
export async function boundedResponseJson(
	response: Request | Response,
	maximum: number,
): Promise<Record<string, unknown>> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error('Body required');
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			length += value.length;
			if (length > maximum) throw new Error('Body too large');
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
