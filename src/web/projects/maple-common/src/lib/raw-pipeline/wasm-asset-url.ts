// Every app build publishes the binary at pkg/raw_wasm_bg.wasm below the
// app base URL. Workers are emitted beside the app's JS bundles, so their
// parent directory preserves a configured <base href> without needing DOM
// access. Vite serves source workers below /src during workflow tests; those
// run at the origin root, so use that root instead.
const documentRef = Reflect.get(globalThis, 'document') as { baseURI?: string } | undefined;
const locationRef = Reflect.get(globalThis, 'location') as { href?: string } | undefined;
const currentUrl = new URL(locationRef?.href ?? 'http://localhost/');
const appBaseUrl = documentRef?.baseURI
  ? new URL(documentRef.baseURI)
  : currentUrl.pathname.endsWith('.ts')
    ? new URL('/', currentUrl)
    : new URL('.', currentUrl);

export const RAW_WASM_URL = new URL('pkg/raw_wasm_bg.wasm', appBaseUrl).href;
