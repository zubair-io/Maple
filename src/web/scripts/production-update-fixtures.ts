import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const WEB_ROOT = resolve(import.meta.dirname, '..');
const SOURCE_ARTIFACT = resolve(WEB_ROOT, 'dist/maple-syrup/browser');
const FIXTURE_ROOT = resolve(WEB_ROOT, 'dist/maple-syrup-update-e2e');
const NGSW_CONFIG = resolve(WEB_ROOT, 'ngsw-config.hosted.json');
const NGSW_CONFIG_BIN = resolve(WEB_ROOT, 'node_modules/@angular/service-worker/ngsw-config.js');

export interface HostedUpdateFixtures {
  readonly v1: string;
  readonly v2: string;
}

async function generateManifest(artifact: string): Promise<void> {
  const process = Bun.spawn(
    [
      'bun',
      relative(WEB_ROOT, NGSW_CONFIG_BIN),
      relative(WEB_ROOT, artifact),
      relative(WEB_ROOT, NGSW_CONFIG),
    ],
    { cwd: WEB_ROOT, stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await process.exited) !== 0) throw new Error(`ngsw-config failed for ${artifact}`);
}

async function createVersion(version: 'v1' | 'v2'): Promise<string> {
  const artifact = resolve(FIXTURE_ROOT, version);
  await cp(SOURCE_ARTIFACT, artifact, { recursive: true });
  const indexPath = resolve(artifact, 'index.html');
  const index = await readFile(indexPath, 'utf8');
  if (!index.includes('</head>')) throw new Error(`${indexPath} has no closing head tag`);
  await writeFile(
    indexPath,
    index.replace('</head>', `<meta name="maple-e2e-version" content="${version}"></head>`),
  );
  await generateManifest(artifact);
  return artifact;
}

export async function prepareHostedUpdateFixtures(): Promise<HostedUpdateFixtures> {
  await rm(FIXTURE_ROOT, { recursive: true, force: true });
  const v1 = await createVersion('v1');
  const v2 = await createVersion('v2');
  const [manifestV1, manifestV2] = await Promise.all(
    [v1, v2].map((artifact) => readFile(resolve(artifact, 'ngsw.json'), 'utf8')),
  );
  if (manifestV1 === manifestV2) throw new Error('Hosted update manifests must differ');
  return { v1, v2 };
}
