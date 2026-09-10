/**
 * Platform detection and native package resolution for @justmaple/maple.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Detect whether the current Linux environment uses musl libc (e.g. Alpine Linux).
 */
export function isMusl(): boolean {
  if (process.platform !== 'linux') return false;

  // 1. Check Node.js process report for glibc
  try {
    const report = (
      process as unknown as {
        report?: {
          getReport?: () => { header?: { glibcVersionRuntime?: string } };
        };
      }
    ).report?.getReport?.();
    if (report?.header?.glibcVersionRuntime) {
      return false;
    }
  } catch {}

  // 2. Check for Alpine Linux release file
  try {
    if (fs.existsSync('/etc/alpine-release')) {
      return true;
    }
  } catch {}

  // 3. Probe dynamic linker in /lib or /lib64
  try {
    for (const dir of ['/lib', '/lib64', '/usr/lib']) {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        if (files.some((f) => f.startsWith('ld-musl-'))) {
          return true;
        }
      }
    }
  } catch {}

  // 4. Probe ldd version output if available
  try {
    const bun = (
      globalThis as unknown as {
        Bun?: {
          spawnSync: (args: string[]) => { stdout?: Buffer; stderr?: Buffer };
        };
      }
    ).Bun;
    if (bun) {
      const res = bun.spawnSync(['ldd', '--version']);
      const text = (res.stdout?.toString() || '') + (res.stderr?.toString() || '');
      if (text.toLowerCase().includes('musl')) {
        return true;
      }
    }
  } catch {}

  return false;
}

/**
 * Returns the expected platform binary package name for the current runtime, or null if unsupported.
 */
export function getPlatformPackageName(
  platform = process.platform,
  arch = process.arch,
  musl = isMusl(),
): string | null {
  if (platform === 'darwin') {
    if (arch === 'arm64') return '@justmaple/maple-darwin-arm64';
    if (arch === 'x64') return '@justmaple/maple-darwin-x64';
  } else if (platform === 'linux') {
    const libc = musl ? 'musl' : 'gnu';
    if (arch === 'x64') return `@justmaple/maple-linux-x64-${libc}`;
    if (arch === 'arm64') return `@justmaple/maple-linux-arm64-${libc}`;
  } else if (platform === 'win32') {
    if (arch === 'x64') return '@justmaple/maple-win32-x64-msvc';
  }

  return null;
}

/**
 * Platform-specific dynamic library file name.
 */
export function getPlatformBinaryFilename(platform = process.platform): string {
  if (platform === 'win32') return 'raw_ffi.dll';
  if (platform === 'darwin') return 'libraw_ffi.dylib';
  return 'libraw_ffi.so';
}

/**
 * Resolves the native shared library from an installed platform package in node_modules.
 */
export function resolvePlatformPackageLib(): string | null {
  const pkgName = getPlatformPackageName();
  if (!pkgName) return null;

  const libName = getPlatformBinaryFilename();

  // 1. Try require.resolve for package main or direct binary
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const resolvedMain = require.resolve(pkgName);
    if (fs.existsSync(resolvedMain) && fs.statSync(resolvedMain).isFile()) {
      return path.resolve(resolvedMain);
    }
  } catch {}

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const resolvedFile = require.resolve(`${pkgName}/${libName}`);
    if (fs.existsSync(resolvedFile)) {
      return path.resolve(resolvedFile);
    }
  } catch {}

  // 2. Try relative node_modules from this module or cwd
  const currentDir =
    (import.meta as { dir?: string }).dir || path.dirname(new URL(import.meta.url).pathname);

  const candidateDirs = [
    path.join(currentDir, '..', '..', pkgName, libName),
    path.join(currentDir, '..', 'node_modules', pkgName, libName),
    path.join(process.cwd(), 'node_modules', pkgName, libName),
  ];

  for (const candidate of candidateDirs) {
    if (fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }

  return null;
}
