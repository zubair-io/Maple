#!/usr/bin/env bun
/**
 * assemble-packages.ts — Assemble platform-specific npm packages by placing
 * compiled native binaries and documentation into each package's distribution folder.
 *
 * Usage:
 *   bun scripts/assemble-packages.ts <artifacts-dir> [--allow-partial]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const mapleDir = path.resolve(scriptDir, '..');
const npmDir = path.resolve(mapleDir, 'npm');

const artifactsDirArg = process.argv[2] || 'artifacts';
const allowPartial = process.argv.includes('--allow-partial');
const artifactsDir = path.resolve(process.cwd(), artifactsDirArg);

interface PlatformSpec {
  dir: string;
  binaryName: string;
  /**
   * Filename of the prebuilt napi (`.node`) addon for this platform, matching
   * `getPlatformNapiFilename()` in `src/maple/src/platform.ts` exactly
   * (`raw-napi.<dir>.node`) — keep the two in sync. Unlike `binaryName`
   * (the bun:ffi dylib/so/dll), a missing napi addon does not fail assembly:
   * the published package still works via the bun:ffi fallback.
   */
  napiBinaryName: string;
  artifactNames: string[];
}

const PLATFORMS: PlatformSpec[] = [
  {
    dir: 'darwin-arm64',
    binaryName: 'libraw_ffi.dylib',
    napiBinaryName: 'raw-napi.darwin-arm64.node',
    artifactNames: ['maple-darwin-arm64', 'darwin-arm64', 'aarch64-apple-darwin'],
  },
  {
    dir: 'darwin-x64',
    binaryName: 'libraw_ffi.dylib',
    napiBinaryName: 'raw-napi.darwin-x64.node',
    artifactNames: ['maple-darwin-x64', 'darwin-x64', 'x86_64-apple-darwin'],
  },
  {
    dir: 'linux-x64-gnu',
    binaryName: 'libraw_ffi.so',
    napiBinaryName: 'raw-napi.linux-x64-gnu.node',
    artifactNames: ['maple-linux-x64-gnu', 'linux-x64-gnu', 'x86_64-unknown-linux-gnu'],
  },
  {
    dir: 'linux-x64-musl',
    binaryName: 'libraw_ffi.so',
    napiBinaryName: 'raw-napi.linux-x64-musl.node',
    artifactNames: ['maple-linux-x64-musl', 'linux-x64-musl', 'x86_64-unknown-linux-musl'],
  },
  {
    dir: 'linux-arm64-gnu',
    binaryName: 'libraw_ffi.so',
    napiBinaryName: 'raw-napi.linux-arm64-gnu.node',
    artifactNames: ['maple-linux-arm64-gnu', 'linux-arm64-gnu', 'aarch64-unknown-linux-gnu'],
  },
  {
    dir: 'linux-arm64-musl',
    binaryName: 'libraw_ffi.so',
    napiBinaryName: 'raw-napi.linux-arm64-musl.node',
    artifactNames: ['maple-linux-arm64-musl', 'linux-arm64-musl', 'aarch64-unknown-linux-musl'],
  },
  {
    dir: 'win32-x64-msvc',
    binaryName: 'raw_ffi.dll',
    napiBinaryName: 'raw-napi.win32-x64-msvc.node',
    artifactNames: ['maple-win32-x64-msvc', 'win32-x64-msvc', 'x86_64-pc-windows-msvc'],
  },
];

console.log(`Assembling packages from artifacts at: ${artifactsDir}`);

/**
 * Candidate locations for a compiled artifact file, in priority order:
 * the artifact's own download-artifact directory (named after the artifact
 * itself, e.g. `maple-linux-x64-gnu` or `maple-linux-x64-gnu-napi`), a
 * flat `<artifact>-<filename>` fallback, and the raw cargo target dir for
 * local, non-CI runs.
 */
function artifactCandidates(
  artifactNames: string[],
  fileName: string,
  artifactSuffix = '',
): string[] {
  const inArtifactDir = artifactNames.map((artName) =>
    path.join(artifactsDir, `${artName}${artifactSuffix}`, fileName),
  );
  const asPrefixedFile = artifactNames.map((artName) =>
    path.join(artifactsDir, `${artName}${artifactSuffix}-${fileName}`),
  );
  const inCargoTarget = artifactNames.map((artName) =>
    path.resolve(mapleDir, '..', 'raw-pipeline', 'target', artName, 'release', fileName),
  );
  return [...inArtifactDir, ...asPrefixedFile, ...inCargoTarget];
}

/** Candidate locations for a platform's compiled bun:ffi binary, in priority order. */
function binaryCandidates(platform: PlatformSpec): string[] {
  return artifactCandidates(platform.artifactNames, platform.binaryName);
}

/**
 * Candidate locations for a platform's compiled napi (`.node`) addon, in
 * priority order. CI uploads this as a separate artifact named
 * `${pkg_name}-napi` (see `.github/workflows/publish-package.yml`), so the
 * artifact-dir candidates carry that `-napi` suffix ahead of the plain ones.
 */
function napiBinaryCandidates(platform: PlatformSpec): string[] {
  return [
    ...artifactCandidates(platform.artifactNames, platform.napiBinaryName, '-napi'),
    ...artifactCandidates(platform.artifactNames, platform.napiBinaryName),
  ];
}

function megabytes(file: string): string {
  return (fs.statSync(file).size / 1024 / 1024).toFixed(2);
}

/** Place the platform's binary and README; returns false when no binary was found. */
function assemblePlatform(platform: PlatformSpec): boolean {
  const targetDir = path.join(npmDir, platform.dir);
  if (!fs.existsSync(targetDir)) {
    console.error(`Error: Destination directory ${targetDir} does not exist.`);
    return false;
  }

  const sourceBinary = binaryCandidates(platform).find((candidate) => fs.existsSync(candidate));
  const destBinary = path.join(targetDir, platform.binaryName);

  // A binary left in npm/<dir>/ by an earlier run is never reused: it is
  // gitignored, so nothing ties it to this build, and publishing it would ship
  // a stale package with no error. It is removed so a partial assembly cannot
  // pick it up either.
  if (!sourceBinary) {
    const stale = fs.existsSync(destBinary);
    fs.rmSync(destBinary, { force: true });
    console.warn(
      `  ✗ Missing binary for platform: ${platform.dir} (${platform.binaryName})` +
        (stale ? ' — a leftover from an earlier run was present and has been removed' : ''),
    );
  } else {
    fs.copyFileSync(sourceBinary, destBinary);
    console.log(
      `  ✓ Assembled [${platform.dir}]: copied ${platform.binaryName} (${megabytes(destBinary)} MB)`,
    );
  }

  // napi addon: optional. Unlike the bun:ffi binary above, a missing `.node`
  // does not fail assembly (and is not counted against --allow-partial) — the
  // published package still runs via the bun:ffi fallback (see
  // `native-napi.ts`/`resolvePlatformNapiAddon`) when napi genuinely isn't
  // available for a platform.
  const sourceNapi = napiBinaryCandidates(platform).find((candidate) => fs.existsSync(candidate));
  const destNapi = path.join(targetDir, platform.napiBinaryName);

  if (!sourceNapi) {
    const staleNapi = fs.existsSync(destNapi);
    fs.rmSync(destNapi, { force: true });
    console.warn(
      `  ✗ Missing napi addon for platform: ${platform.dir} (${platform.napiBinaryName})` +
        ' — package will fall back to bun:ffi at runtime' +
        (staleNapi ? ' — a leftover from an earlier run was present and has been removed' : ''),
    );
  } else {
    fs.copyFileSync(sourceNapi, destNapi);
    console.log(
      `  ✓ Assembled [${platform.dir}]: copied ${platform.napiBinaryName} (${megabytes(destNapi)} MB)`,
    );
  }

  // Ensure README exists
  const readmePath = path.join(targetDir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    const pkg = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf-8'));
    fs.writeFileSync(readmePath, `# ${pkg.name}\n\n${pkg.description}.\n`, 'utf-8');
  }

  return sourceBinary !== undefined;
}

const missingCount = PLATFORMS.filter((platform) => !assemblePlatform(platform)).length;

if (missingCount > 0 && !allowPartial) {
  console.error(`\nAssembly failed: ${missingCount} platform binary package(s) incomplete.`);
  process.exit(1);
}

console.log('\nAll platform packages assembled successfully.');
