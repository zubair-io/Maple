// Single served URL of the wasm-bindgen binary. Every app build copies
// raw_wasm_bg.wasm to /pkg/ (angular.json assets) and the workflow vite
// server mirrors that layout (e2e/workflow/vite.config.ts publicDir), so
// all init sites pass this explicitly: the glue's default resolves
// relative to the bundled chunk at the server root, where no binary lives.
export const RAW_WASM_URL = '/pkg/raw_wasm_bg.wasm';
