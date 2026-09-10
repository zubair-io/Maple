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
  artifactNames: string[];
}

const PLATFORMS: PlatformSpec[] = [
  {
    dir: 'darwin-arm64',
    binaryName: 'libraw_ffi.dylib',
    artifactNames: ['maple-darwin-arm64', 'darwin-arm64', 'aarch64-apple-darwin'],
  },
  {
    dir: 'darwin-x64',
    binaryName: 'libraw_ffi.dylib',
    artifactNames: ['maple-darwin-x64', 'darwin-x64', 'x86_64-apple-darwin'],
  },
  {
    dir: 'linux-x64-gnu',
    binaryName: 'libraw_ffi.so',
    artifactNames: ['maple-linux-x64-gnu', 'linux-x64-gnu', 'x86_64-unknown-linux-gnu'],
  },
  {
    dir: 'linux-x64-musl',
    binaryName: 'libraw_ffi.so',
    artifactNames: ['maple-linux-x64-musl', 'linux-x64-musl', 'x86_64-unknown-linux-musl'],
  },
  {
    dir: 'linux-arm64-gnu',
    binaryName: 'libraw_ffi.so',
    artifactNames: ['maple-linux-arm64-gnu', 'linux-arm64-gnu', 'aarch64-unknown-linux-gnu'],
  },
  {
    dir: 'linux-arm64-musl',
    binaryName: 'libraw_ffi.so',
    artifactNames: ['maple-linux-arm64-musl', 'linux-arm64-musl', 'aarch64-unknown-linux-musl'],
  },
  {
    dir: 'win32-x64-msvc',
    binaryName: 'raw_ffi.dll',
    artifactNames: ['maple-win32-x64-msvc', 'win32-x64-msvc', 'x86_64-pc-windows-msvc'],
  },
];

console.log(`Assembling packages from artifacts at: ${artifactsDir}`);

/** Candidate locations for a platform's compiled binary, in priority order. */
function binaryCandidates(platform: PlatformSpec): string[] {
  const inArtifactDir = platform.artifactNames.map((artName) =>
    path.join(artifactsDir, artName, platform.binaryName),
  );
  const asPrefixedFile = platform.artifactNames.map((artName) =>
    path.join(artifactsDir, `${artName}-${platform.binaryName}`),
  );
  const inCargoTarget = platform.artifactNames.map((artName) =>
    path.resolve(mapleDir, '..', 'raw-pipeline', 'target', artName, 'release', platform.binaryName),
  );
  return [...inArtifactDir, ...asPrefixedFile, ...inCargoTarget];
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
