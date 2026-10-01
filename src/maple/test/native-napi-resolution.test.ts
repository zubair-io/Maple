import { expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { getPlatformNapiFilename, getPlatformPackageName } from '../src/platform';

const packageName = getPlatformPackageName();
if (packageName === null) throw new Error('N-API resolution tests require a supported platform');
const addonName = getPlatformNapiFilename();
const libraryName =
  process.platform === 'darwin'
    ? 'libraw_napi.dylib'
    : process.platform === 'win32'
      ? 'raw_napi.dll'
      : 'libraw_napi.so';
const target =
  process.platform === 'darwin'
    ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
    : process.platform === 'win32'
      ? 'x86_64-pc-windows-msvc'
      : `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-gnu`;

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'maple-napi-resolution-')));
  const packageRoot = path.join(root, 'src', 'maple');
  const entry = path.join(packageRoot, 'src', 'platform.ts');
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.copyFile(path.resolve(import.meta.dir, '../src/platform.ts'), entry);
  const installed = path.join(packageRoot, 'node_modules', packageName!, addonName);
  const assembled = path.join(
    packageRoot,
    'npm',
    packageName!.replace('@justmaple/maple-', ''),
    addonName,
  );
  const host = path.join(root, 'src', 'raw-pipeline', 'target', 'release', libraryName);
  const cross = path.join(root, 'src', 'raw-pipeline', 'target', target, 'release', libraryName);
  const write = async (file: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (file === installed) {
      await fs.writeFile(
        path.join(path.dirname(file), 'package.json'),
        JSON.stringify({ name: packageName, version: '0.0.0', private: true }),
      );
    }
    // Resolution only checks paths; loading is exercised by the native engine suites.
    await fs.writeFile(file, 'resolver fixture');
  };
  const resolve = async () => {
    const script = `import { resolvePlatformNapiAddon } from ${JSON.stringify(entry)};
      console.log(JSON.stringify(resolvePlatformNapiAddon()));`;
    const child = Bun.spawn([process.execPath, '--no-install', '-e', script], {
      cwd: packageRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout.trim()) as string | null;
  };
  return { root, installed, assembled, host, cross, write, resolve };
}

test('source-built N-API wins over installed and assembled packages (#3996)', async () => {
  const tree = await fixture();
  try {
    await tree.write(tree.installed);
    await tree.write(tree.assembled);
    await tree.write(tree.host);
    expect(await tree.resolve()).toBe(tree.host);
  } finally {
    await fs.rm(tree.root, { recursive: true, force: true });
  }
});

test('target-specific source-built N-API wins when the host release library is absent', async () => {
  const tree = await fixture();
  try {
    await tree.write(tree.installed);
    await tree.write(tree.assembled);
    await tree.write(tree.cross);
    expect(await tree.resolve()).toBe(tree.cross);
  } finally {
    await fs.rm(tree.root, { recursive: true, force: true });
  }
});

test('installed platform packages remain available without a source-built addon', async () => {
  const tree = await fixture();
  try {
    await tree.write(tree.installed);
    await tree.write(tree.assembled);
    expect(await tree.resolve()).toBe(tree.installed);
  } finally {
    await fs.rm(tree.root, { recursive: true, force: true });
  }
});

test('assembled packages remain available without source-built or installed addons', async () => {
  const tree = await fixture();
  try {
    await tree.write(tree.assembled);
    expect(await tree.resolve()).toBe(tree.assembled);
  } finally {
    await fs.rm(tree.root, { recursive: true, force: true });
  }
});

test('an empty install tree has no N-API addon', async () => {
  const tree = await fixture();
  try {
    expect(await tree.resolve()).toBeNull();
  } finally {
    await fs.rm(tree.root, { recursive: true, force: true });
  }
});
