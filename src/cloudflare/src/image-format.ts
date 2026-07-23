import decodeAvif, { init as initAvifDecoder } from '@jsquash/avif/decode';
import encodeJpeg, { init as initJpegEncoder } from '@jsquash/jpeg/encode';
import AVIF_DECODER_WASM from '../node_modules/@jsquash/avif/codec/dec/avif_dec.wasm';
import JPEG_ENCODER_WASM from '../node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm';

const JPEG_QUALITY = 85;

type WasmInitializer = (
	module: WebAssembly.Module,
	options: { locateFile: (path: string) => string },
) => Promise<void>;

let codecsReady: Promise<void> | undefined;

function initializeCodecs(): Promise<void> {
	if (!codecsReady) {
		// Even with a precompiled module, Emscripten resolves a nominal WASM
		// filename while constructing the codec. Cloudflare does not provide a
		// usable import.meta.url, so force that resolution down locateFile's
		// branch. No request is made: jSquash's instantiateWasm callback uses
		// the imported WebAssembly.Module directly.
		const options = {
			locateFile: (path: string) => `https://jsquash.invalid/${path}`,
		};
		codecsReady = Promise.all([
			(initAvifDecoder as WasmInitializer)(AVIF_DECODER_WASM, options),
			(initJpegEncoder as WasmInitializer)(JPEG_ENCODER_WASM, options),
		]).then(() => undefined);
	}
	return codecsReady;
}

export function requestsJpeg(url: URL): boolean {
	return url.searchParams.get('format') === 'jpg';
}

/**
 * Convert an AVIF response only when the URL explicitly requests JPEG.
 * Representation-specific headers from the AVIF are removed because they no
 * longer describe the returned bytes.
 */
export async function maybeConvertAvifToJpeg(response: Response, url: URL): Promise<Response> {
	if (
		!requestsJpeg(url) ||
		response.status !== 200 ||
		!response.headers.get('content-type')?.toLowerCase().startsWith('image/avif')
	) {
		return response;
	}

	await initializeCodecs();
	const image = await decodeAvif(await response.arrayBuffer());
	if (!image) throw new Error('AVIF decoder returned no image');
	const jpeg = await encodeJpeg(image, { quality: JPEG_QUALITY });
	const headers = new Headers(response.headers);
	headers.set('content-type', 'image/jpeg');
	headers.delete('content-length');
	headers.delete('content-encoding');
	headers.delete('etag');
	return new Response(jpeg, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
