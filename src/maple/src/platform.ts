/**
 * Platform detection and native package resolution for @justmaple/maple.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Detect whether the current Linux environment uses musl libc (e.g. Alpine Linux).
 */
export function isMusl(): boolean {
  if (process.platform !== 'linux') return false;

  // 1. Check Node.js process report for runtime glibc
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

  // 2. Check loaded libraries of the running process via /proc/self/maps
  try {
    if (fs.existsSync('/proc/self/maps')) {
      const maps = fs.readFileSync('/proc/self/maps', 'utf-8');
      if (maps.includes('libc.so') || maps.includes('ld-linux')) {
        return false;
      }
      if (maps.includes('ld-musl-') || maps.includes('libc.musl-')) {
        return true;
      }
    }
  } catch {}

  // 3. Fast check for Alpine Linux release file (unconditionally musl-native)
  try {
    if (fs.existsSync('/etc/alpine-release')) {
      return true;
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
      const text = ((res.stdout?.toString() || '') + (res.stderr?.toString() || '')).toLowerCase();
      if (text.includes('musl')) {
        return true;
      }
      if (text.includes('glibc') || text.includes('gnu libc')) {
        return false;
      }
    }
  } catch {}

  // 5. As a fallback, probe dynamic linker on disk only if runtime libc is indeterminate
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
 * Platform-specific napi addon filename: `raw-napi.<platform>-<arch>[-<abi>].node`.
 * CONFIRMED (#3509 Task 9): this is the exact filename
 * `.github/workflows/publish-package.yml`'s `build-linux`/`build-macos`/
 * `build-windows` jobs produce (plain `cargo build`/`cargo zigbuild` on the
 * cargo-native `.so`/`.dylib`/`.dll`, renamed to this convention by hand —
 * there is no `@napi-rs/cli` in this repo's toolchain), and what
 * `assemble-packages.ts` copies into each `npm/<platform>/` package under
 * this same name. Keep this function and those two build/assemble sites in
 * sync on any future rename.
 */
export function getPlatformNapiFilename(
  platform = process.platform,
  arch = process.arch,
  musl = isMusl(),
): string {
  if (platform === 'darwin') return `raw-napi.darwin-${arch === 'arm64' ? 'arm64' : 'x64'}.node`;
  if (platform === 'win32') return 'raw-napi.win32-x64-msvc.node';
  const libc = musl ? 'musl' : 'gnu';
  return `raw-napi.linux-${arch === 'arm64' ? 'arm64' : 'x64'}-${libc}.node`;
}

/**
 * The `raw-napi` crate's own cargo-produced dynamic library filename (NOT
 * renamed to `.node`) — what `cargo build --release -p raw-napi` actually
 * leaves in a `target` release directory, used only by this function's
 * local-dev fallback candidates below.
 */
function napiCargoLibFilename(platform = process.platform): string {
  if (platform === 'win32') return 'raw_napi.dll';
  if (platform === 'darwin') return 'libraw_napi.dylib';
  return 'libraw_napi.so';
}

/**
 * Resolves the napi addon the same way `resolvePlatformPackageLib` resolves
 * the bun:ffi dylib — installed platform package first, then monorepo-local
 * dev paths. Returns null (never throws) when nothing matches, so the
 * caller (`native-napi.ts`) can fall back to bun:ffi.
 *
 * The monorepo-dev candidates point straight at `raw-napi`'s own cargo
 * target dir, at the plain `.dylib`/`.so` cargo produces — NOT renamed to
 * `.node`. That is deliberate: `native-napi.ts` loads whatever path this
 * returns via `process.dlopen` rather than `require`, which works
 * regardless of the file's extension (verified empirically — a bare
 * `require()` on a `.dylib`-suffixed path throws `Invalid or unexpected
 * token` on both Node and Bun, since each module loader picks a handler by
 * extension and neither registers one for `.dylib`/`.so`; `process.dlopen`
 * is the same primitive their own built-in `.node` loader calls internally,
 * and Node's own docs recommend it directly over `require()` for loading a
 * native addon from an ES module — see `native-napi.ts`'s loader).
 */
export function resolvePlatformNapiAddon(): string | null {
  const pkgName = getPlatformPackageName();
  if (!pkgName) return null;
  const napiName = getPlatformNapiFilename();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const resolved = require.resolve(`${pkgName}/${napiName}`);
    if (fs.existsSync(resolved)) return path.resolve(resolved);
  } catch {}

  const currentDir =
    (import.meta as { dir?: string }).dir || path.dirname(fileURLToPath(import.meta.url));
  const shortName = pkgName.replace('@justmaple/maple-', '');
  const napiCargoTarget = path.join(currentDir, '..', '..', 'raw-pipeline', 'target');
  const napiLibName = napiCargoLibFilename();

  const candidates = [
    path.join(currentDir, '..', '..', pkgName, napiName),
    path.join(currentDir, '..', 'node_modules', pkgName, napiName),
    path.join(process.cwd(), 'node_modules', pkgName, napiName),
    path.join(currentDir, '..', 'npm', shortName, napiName),
    path.join(process.cwd(), 'npm', shortName, napiName),
    // Local dev: raw-napi's own cargo target dir, matching native.ts's
    // findNativeLib's own "source-built binary takes priority inside the
    // monorepo checkout" convention.
    path.join(napiCargoTarget, 'release', napiLibName),
    path.join(napiCargoTarget, 'aarch64-apple-darwin', 'release', napiLibName),
    path.join(napiCargoTarget, 'x86_64-apple-darwin', 'release', napiLibName),
    path.join(napiCargoTarget, 'x86_64-unknown-linux-gnu', 'release', napiLibName),
    path.join(napiCargoTarget, 'aarch64-unknown-linux-gnu', 'release', napiLibName),
    path.join(napiCargoTarget, 'x86_64-pc-windows-msvc', 'release', napiLibName),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
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

  // 2. Try relative node_modules from this module or cwd, or assembled local npm folder
  const currentDir =
    (import.meta as { dir?: string }).dir || path.dirname(fileURLToPath(import.meta.url));
  const shortName = pkgName.replace('@justmaple/maple-', '');

  const candidateDirs = [
    path.join(currentDir, '..', '..', pkgName, libName),
    path.join(currentDir, '..', 'node_modules', pkgName, libName),
    path.join(process.cwd(), 'node_modules', pkgName, libName),
    path.join(currentDir, '..', 'npm', shortName, libName),
    path.join(process.cwd(), 'npm', shortName, libName),
  ];

  for (const candidate of candidateDirs) {
    if (fs.existsSync(candidate)) {
      return path.resolve(candidate);
    }
  }

  return null;
}
