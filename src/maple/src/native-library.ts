/** Native shared-library resolution, shared by availability and loading. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePlatformPackageLib } from './platform';

/** Find the platform-specific library name */
export function nativeLibFilename(): string {
  if (process.platform === 'win32') return 'raw_ffi.dll';
  if (process.platform === 'darwin') return 'libraw_ffi.dylib';
  return 'libraw_ffi.so';
}

/** First candidate path that exists on disk, or null. */
function firstExisting(candidates: readonly string[]): string | null {
  const hit = candidates.find((candidate) => fs.existsSync(candidate));
  return hit ? path.resolve(hit) : null;
}

/**
 * Locate the native shared library.
 *
 * Order: the explicit `MAPLE_NATIVE_LIB` override, then a binary built from
 * this checkout, then the installed `@justmaple/maple-<platform>` package,
 * then generic runtime locations. The source-built paths point at sibling
 * crates/packages that only exist inside the monorepo (an installed npm
 * package never has them), so they are an explicit "use what `cargo build`
 * just produced" selection, not a search of arbitrary local files — a local
 * pipeline change is what `bun test` and the API exercise, never a stale
 * prebuilt pulled in by `bun install`.
 */
export function findNativeLib(): string | null {
  if (process.env.MAPLE_NATIVE_LIB && fs.existsSync(process.env.MAPLE_NATIVE_LIB)) {
    return process.env.MAPLE_NATIVE_LIB;
  }

  const libName = nativeLibFilename();
  const currentDir =
    (import.meta as { dir?: string }).dir || path.dirname(fileURLToPath(import.meta.url));
  const cargoTarget = path.join(currentDir, '..', '..', 'raw-pipeline', 'target');

  const sourceBuilt = [
    path.join(cargoTarget, 'release', libName),
    path.join(cargoTarget, 'aarch64-apple-darwin', 'release', libName),
    path.join(cargoTarget, 'x86_64-apple-darwin', 'release', libName),
    path.join(cargoTarget, 'x86_64-unknown-linux-gnu', 'release', libName),
    path.join(cargoTarget, 'aarch64-unknown-linux-gnu', 'release', libName),
    path.join(cargoTarget, 'x86_64-pc-windows-msvc', 'release', libName),
    // src/api/native/ — written by src/api/scripts/build-raw-ffi.sh
    path.join(currentDir, '..', '..', 'api', 'native', libName),
  ];

  const runtime = [
    // Pre-bundled in native/ inside package
    path.join(currentDir, '..', 'native', libName),
    // Current working directory native/ (e.g. /app/native in Docker or server root)
    path.join(process.cwd(), 'native', libName),
    // Direct Docker runtime container path
    path.join('/app', 'native', libName),
    // Standard Linux system library locations
    path.join('/usr/local/lib', libName),
    path.join('/usr/lib', libName),
  ];

  return firstExisting(sourceBuilt) ?? resolvePlatformPackageLib() ?? firstExisting(runtime);
}
