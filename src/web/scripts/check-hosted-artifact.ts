import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';
import { HOSTED_ICONS, HOSTED_LOCAL_FONTS, HOSTED_WASM_ASSETS } from './hosted-artifact-contract';
import { HOSTED_SECURITY_HEADERS } from './hosted-security-header-contract';

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
  readonly navigationUrls?: readonly { readonly positive: boolean; readonly regex: string }[];
}

interface WebManifest {
  readonly id?: string;
  readonly scope?: string;
  readonly start_url?: string;
  readonly icons?: readonly { readonly src?: string; readonly sizes?: string }[];
}

type HeaderRules = ReadonlyMap<string, ReadonlyMap<string, string>>;

function fail(message: string): never {
  throw new Error(`Hosted artifact contract failed: ${message}`);
}

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
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

async function text(path: string): Promise<string> {
  try {
    return await readFile(resolve(ARTIFACT_ROOT, `.${path}`), 'utf8');
  } catch {
    return fail(`missing ${path}`);
  }
}

function headerRuleLines(source: string): readonly string[] {
  return source
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
}

function addHeader(rawLine: string, current: Map<string, string> | undefined): void {
  assertContract(current, `header appears before a path rule: ${rawLine.trim()}`);
  const separator = rawLine.indexOf(':');
  assertContract(separator > 0, `invalid header line: ${rawLine.trim()}`);
  const name = rawLine.slice(0, separator).trim();
  assertContract(!current.has(name), `duplicate ${name} header`);
  current.set(name, rawLine.slice(separator + 1).trim());
}

function parseHeaderRules(source: string): HeaderRules {
  const rules = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const rawLine of headerRuleLines(source)) {
    if (/^\s/.test(rawLine)) {
      addHeader(rawLine, current);
    } else {
      current = new Map();
      rules.set(rawLine.trim(), current);
    }
  }
  return rules;
}

async function verifySecurityHeaders(): Promise<void> {
  const rules = parseHeaderRules(await text('/_headers'));
  const wildcard = rules.get('/*') ?? fail('_headers omits /*');
  for (const [name, expected] of Object.entries(HOSTED_SECURITY_HEADERS)) {
    assertContract(wildcard.get(name) === expected, `_headers has invalid ${name}`);
  }
  assertContract(
    rules.get('/raw_wasm_bg.wasm')?.get('Content-Type') === 'application/wasm',
    '_headers omits the WASM MIME override',
  );
}

async function verifyIndexCspCompatibility(): Promise<void> {
  const index = await text('/index.html');
  assertContract(
    !/<[a-z][^>]*\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(index),
    'index.html contains an inline event handler forbidden by the Hosted CSP',
  );
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
  assertContract(missing.length === 0, `${groupName} omits ${missing.join(', ')}`);
}

async function verifyManifestAndIcons(): Promise<void> {
  const manifest = await json<WebManifest>('/manifest.webmanifest');
  verifyManifestRoot(manifest);
  const declared = new Map((manifest.icons ?? []).map((icon) => [`/${icon.src}`, icon.sizes]));
  for (const icon of HOSTED_ICONS) {
    await verifyIcon(icon, declared);
  }
}

function verifyManifestRoot(manifest: WebManifest): void {
  assertContract(manifest.id === '/', 'manifest id must be /');
  assertContract(manifest.scope === '/', 'manifest scope must be /');
  assertContract(manifest.start_url === '/', 'manifest start_url must be /');
}

async function verifyIcon(
  icon: string,
  declared: ReadonlyMap<string, string | undefined>,
): Promise<void> {
  const expectedSize = icon.includes('192') ? '192x192' : '512x512';
  assertContract(
    declared.get(icon) === expectedSize,
    `manifest does not declare ${icon} as ${expectedSize}`,
  );
  assertContract(
    startsWith(await bytes(icon), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    `${icon} is not a PNG`,
  );
}

async function verifyBinaryAssets(): Promise<string> {
  for (const font of HOSTED_LOCAL_FONTS) {
    assertContract(startsWith(await bytes(font), [0x77, 0x4f, 0x46, 0x32]), `${font} is not WOFF2`);
  }
  assertContract(
    startsWith(await bytes('/raw_wasm_bg.wasm'), [0x00, 0x61, 0x73, 0x6d]),
    '/raw_wasm_bg.wasm has invalid magic bytes',
  );
  for (const helper of HOSTED_WASM_ASSETS.slice(1)) {
    assertContract((await bytes(helper)).byteLength > 0, `${helper} is empty`);
  }

  const snippetRoot = resolve(ARTIFACT_ROOT, 'pkg/snippets');
  const workerHelpers = (await allFiles(snippetRoot)).filter(
    (path) => basename(path) === 'workerHelpers.js',
  );
  assertContract(
    workerHelpers.length === 1,
    `expected one Rayon workerHelpers.js, found ${workerHelpers.length}`,
  );
  return `/${relative(ARTIFACT_ROOT, workerHelpers[0]).split(sep).join('/')}`;
}

function urls(group: NgswAssetGroup): readonly string[] {
  return group.urls ?? [];
}

function verifyNoHostedDataCaches(manifest: NgswManifest): void {
  assertContract(
    manifest.dataGroups === undefined || manifest.dataGroups.length === 0,
    'Hosted ngsw.json must not contain dataGroups',
  );
  const cachedResources = manifest.assetGroups.flatMap((assetGroup) => [
    ...urls(assetGroup),
    ...(assetGroup.patterns ?? []),
  ]);
  assertContract(
    !cachedResources.some((resource) => resource.replaceAll('\\', '').includes('/api')),
    'Hosted ngsw.json contains an API cache URL',
  );
  assertContract(
    manifest.navigationUrls?.some(
      (rule) => !rule.positive && new RegExp(rule.regex).test('/api/contract-probe'),
    ),
    'Hosted ngsw.json does not exclude /api navigation',
  );
}

function verifyAssetGroups(manifest: NgswManifest, rayonHelper: string): readonly string[] {
  const appUrls = urls(group(manifest, 'app'));
  requireUrls('app group', appUrls, ['/index.html', '/manifest.webmanifest']);
  requireUrls('raw-wasm group', urls(group(manifest, 'raw-wasm')), [
    ...HOSTED_WASM_ASSETS,
    rayonHelper,
  ]);
  requireUrls('fonts group', urls(group(manifest, 'fonts')), HOSTED_LOCAL_FONTS);
  requireUrls('images group', urls(group(manifest, 'images')), HOSTED_ICONS);
  return appUrls;
}

async function verifyNgsw(rayonHelper: string): Promise<number> {
  const manifest = await json<NgswManifest>('/ngsw.json');
  verifyNoHostedDataCaches(manifest);
  const appUrls = verifyAssetGroups(manifest, rayonHelper);

  const appShellBytes = (
    await Promise.all(
      appUrls.map(async (url) => (await stat(resolve(ARTIFACT_ROOT, `.${url}`))).size),
    )
  ).reduce((sum, size) => sum + size, 0);
  assertContract(
    appShellBytes <= MAX_APP_SHELL_BYTES,
    `app shell is ${appShellBytes} bytes; budget is ${MAX_APP_SHELL_BYTES}`,
  );
  return appShellBytes;
}

await verifyManifestAndIcons();
await verifySecurityHeaders();
await verifyIndexCspCompatibility();
const rayonHelper = await verifyBinaryAssets();
const appShellBytes = await verifyNgsw(rayonHelper);
console.log(
  `Hosted artifact contract passed (${appShellBytes} app-shell bytes, ${HOSTED_LOCAL_FONTS.length} local fonts, ${HOSTED_ICONS.length} icons).`,
);
