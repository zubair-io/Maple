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

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
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

let missingCount = 0;

for (const platform of PLATFORMS) {
  const targetDir = path.join(npmDir, platform.dir);
  if (!fs.existsSync(targetDir)) {
    console.error(`Error: Destination directory ${targetDir} does not exist.`);
    missingCount++;
    continue;
  }

  // Find candidate binary in artifactsDir
  let sourceBinary: string | null = null;

  // 1. Search in subdirectories matching artifact names
  for (const artName of platform.artifactNames) {
    const subCandidate = path.join(artifactsDir, artName, platform.binaryName);
    if (fs.existsSync(subCandidate)) {
      sourceBinary = subCandidate;
      break;
    }
  }

  // 2. Search direct filename with platform prefix
  if (!sourceBinary) {
    for (const artName of platform.artifactNames) {
      const fileCandidate = path.join(artifactsDir, `${artName}-${platform.binaryName}`);
      if (fs.existsSync(fileCandidate)) {
        sourceBinary = fileCandidate;
        break;
      }
    }
  }

  // 3. Search raw-pipeline target release fallback
  if (!sourceBinary) {
    for (const artName of platform.artifactNames) {
      const targetCandidate = path.resolve(
        mapleDir,
        '..',
        'raw-pipeline',
        'target',
        artName,
        'release',
        platform.binaryName,
      );
      if (fs.existsSync(targetCandidate)) {
        sourceBinary = targetCandidate;
        break;
      }
    }
  }

  const destBinary = path.join(targetDir, platform.binaryName);

  if (sourceBinary) {
    fs.copyFileSync(sourceBinary, destBinary);
    const stat = fs.statSync(destBinary);
    console.log(
      `  ✓ Assembled [${platform.dir}]: copied ${platform.binaryName} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`,
    );
  } else {
    if (fs.existsSync(destBinary)) {
      const stat = fs.statSync(destBinary);
      console.log(
        `  - Reused existing [${platform.dir}]: ${platform.binaryName} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`,
      );
    } else {
      console.warn(`  ✗ Missing binary for platform: ${platform.dir} (${platform.binaryName})`);
      missingCount++;
    }
  }

  // Ensure README exists
  const readmePath = path.join(targetDir, 'README.md');
  if (!fs.existsSync(readmePath)) {
    const pkg = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf-8'));
    fs.writeFileSync(
      readmePath,
      `# ${pkg.name}\n\nPrebuilt native binary for \`@justmaple/maple\` on ${pkg.description}.\n`,
      'utf-8',
    );
  }
}

if (missingCount > 0 && !allowPartial) {
  console.error(`\nAssembly failed: ${missingCount} platform binary package(s) incomplete.`);
  process.exit(1);
}

console.log('\nAll platform packages assembled successfully.');
