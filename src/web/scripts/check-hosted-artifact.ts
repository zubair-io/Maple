import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HOSTED_ICONS, HOSTED_LOCAL_FONTS, HOSTED_WASM_ASSETS } from './hosted-artifact-contract';

const WEB_ROOT = resolve(import.meta.dirname, '..');
const ARTIFACT_ROOT = resolve(
  process.env.MAPLE_HOSTED_ARTIFACT ?? `${WEB_ROOT}/dist/maple-syrup/browser`,
);
const MAX_APP_SHELL_BYTES = 8 * 1024 * 1024;

interface NgswAssetGroup {
  readonly name: string;
  readonly urls?: readonly string[];
  readonly patterns?: readonly string[];
}

interface NgswManifest {
  readonly assetGroups: readonly NgswAssetGroup[];
  readonly dataGroups?: readonly unknown[];
}

interface WebManifest {
  readonly id?: string;
  readonly scope?: string;
  readonly start_url?: string;
  readonly icons?: readonly { readonly src?: string; readonly sizes?: string }[];
}

function fail(message: string): never {
  throw new Error(`Hosted artifact contract failed: ${message}`);
}

async function bytes(path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(resolve(ARTIFACT_ROOT, `.${path}`)));
  } catch {
    return fail(`missing ${path}`);
  }
}

async function json<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(resolve(ARTIFACT_ROOT, `.${path}`), 'utf8')) as T;
  } catch (error) {
    return fail(`${path} is not valid JSON: ${String(error)}`);
  }
}

function startsWith(value: Uint8Array, expected: readonly number[]): boolean {
  return expected.every((byte, index) => value[index] === byte);
}

async function allFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? allFiles(path) : [path];
    }),
  );
  return nested.flat();
}

function group(manifest: NgswManifest, name: string): NgswAssetGroup {
  return (
    manifest.assetGroups.find((candidate) => candidate.name === name) ?? fail(`missing ${name}`)
  );
}

function requireUrls(
  groupName: string,
  actual: readonly string[],
  required: readonly string[],
): void {
  const missing = required.filter((url) => !actual.includes(url));
  if (missing.length > 0) fail(`${groupName} omits ${missing.join(', ')}`);
}

async function verifyManifestAndIcons(): Promise<void> {
  const manifest = await json<WebManifest>('/manifest.webmanifest');
  if (manifest.id !== '/' || manifest.scope !== '/' || manifest.start_url !== '/') {
    fail('manifest id, scope, and start_url must all be /');
  }
  const declared = new Map((manifest.icons ?? []).map((icon) => [`/${icon.src}`, icon.sizes]));
  for (const icon of HOSTED_ICONS) {
    const expectedSize = icon.includes('192') ? '192x192' : '512x512';
    if (declared.get(icon) !== expectedSize)
      fail(`manifest does not declare ${icon} as ${expectedSize}`);
    const value = await bytes(icon);
    if (!startsWith(value, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
      fail(`${icon} is not a PNG`);
    }
  }
}

async function verifyBinaryAssets(): Promise<string> {
  for (const font of HOSTED_LOCAL_FONTS) {
    if (!startsWith(await bytes(font), [0x77, 0x4f, 0x46, 0x32])) fail(`${font} is not WOFF2`);
  }
  if (!startsWith(await bytes('/raw_wasm_bg.wasm'), [0x00, 0x61, 0x73, 0x6d])) {
    fail('/raw_wasm_bg.wasm has invalid magic bytes');
  }
  for (const helper of HOSTED_WASM_ASSETS.slice(1)) {
    if ((await bytes(helper)).byteLength === 0) fail(`${helper} is empty`);
  }

  const snippetRoot = resolve(ARTIFACT_ROOT, 'pkg/snippets');
  const workerHelpers = (await allFiles(snippetRoot)).filter((path) =>
    path.endsWith('/workerHelpers.js'),
  );
  if (workerHelpers.length !== 1)
    fail(`expected one Rayon workerHelpers.js, found ${workerHelpers.length}`);
  return `/${workerHelpers[0].slice(ARTIFACT_ROOT.length + 1)}`;
}

async function verifyNgsw(rayonHelper: string): Promise<number> {
  const manifest = await json<NgswManifest>('/ngsw.json');
  if ((manifest.dataGroups?.length ?? 0) !== 0)
    fail('Hosted ngsw.json must not contain dataGroups');

  const cachedResources = manifest.assetGroups.flatMap((assetGroup) => [
    ...(assetGroup.urls ?? []),
    ...(assetGroup.patterns ?? []),
  ]);
  if (
    cachedResources.some((resource) => resource.includes('/api') || resource.includes('\\/api'))
  ) {
    fail('Hosted ngsw.json contains an API cache URL');
  }

  const appUrls = group(manifest, 'app').urls ?? [];
  const rawUrls = group(manifest, 'raw-wasm').urls ?? [];
  const fontUrls = group(manifest, 'fonts').urls ?? [];
  const imageUrls = group(manifest, 'images').urls ?? [];
  requireUrls('app group', appUrls, ['/index.html', '/manifest.webmanifest']);
  requireUrls('raw-wasm group', rawUrls, [...HOSTED_WASM_ASSETS, rayonHelper]);
  requireUrls('fonts group', fontUrls, HOSTED_LOCAL_FONTS);
  requireUrls('images group', imageUrls, HOSTED_ICONS);

  const appShellBytes = (
    await Promise.all(
      appUrls.map(async (url) => (await stat(resolve(ARTIFACT_ROOT, `.${url}`))).size),
    )
  ).reduce((sum, size) => sum + size, 0);
  if (appShellBytes > MAX_APP_SHELL_BYTES) {
    fail(`app shell is ${appShellBytes} bytes; budget is ${MAX_APP_SHELL_BYTES}`);
  }
  return appShellBytes;
}

await verifyManifestAndIcons();
const rayonHelper = await verifyBinaryAssets();
const appShellBytes = await verifyNgsw(rayonHelper);
console.log(
  `Hosted artifact contract passed (${appShellBytes} app-shell bytes, ${HOSTED_LOCAL_FONTS.length} local fonts, ${HOSTED_ICONS.length} icons).`,
);
