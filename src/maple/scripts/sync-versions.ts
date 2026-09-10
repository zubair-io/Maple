#!/usr/bin/env bun
/**
 * sync-versions.ts — Synchronize package versions across root @justmaple/maple
 * and its 7 platform-specific npm packages.
 *
 * Usage:
 *   bun scripts/sync-versions.ts [0.1.0]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const scriptDir = path.dirname(new URL(import.meta.url).pathname);
const mapleDir = path.resolve(scriptDir, '..');
const npmDir = path.resolve(mapleDir, 'npm');

// 1. Determine target version
let targetVersion = process.argv[2];

if (!targetVersion && process.env.GITHUB_REF_NAME) {
  targetVersion = process.env.GITHUB_REF_NAME.replace(/^v/, '');
}

const rootPkgPath = path.join(mapleDir, 'package.json');
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8'));

if (!targetVersion) {
  targetVersion = rootPkg.version;
}

// Clean any leading 'v'
targetVersion = targetVersion.replace(/^v/, '').trim();

if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(targetVersion)) {
  console.error(`Invalid semver version format: "${targetVersion}"`);
  process.exit(1);
}

console.log(`Synchronizing packages to version: ${targetVersion}`);

// 2. Update root package.json
rootPkg.version = targetVersion;
if (rootPkg.optionalDependencies) {
  for (const dep of Object.keys(rootPkg.optionalDependencies)) {
    if (dep.startsWith('@justmaple/maple-')) {
      rootPkg.optionalDependencies[dep] = targetVersion;
    }
  }
}
fs.writeFileSync(rootPkgPath, JSON.stringify(rootPkg, null, 2) + '\n', 'utf-8');
console.log(`Updated root package: ${rootPkgPath}`);

// 3. Update all platform packages under src/maple/npm/
if (fs.existsSync(npmDir)) {
  const platformDirs = fs.readdirSync(npmDir);
  for (const dirName of platformDirs) {
    const pkgJsonPath = path.join(npmDir, dirName, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      pkg.version = targetVersion;
      fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
      console.log(`  ✓ Updated platform package [${pkg.name}]: ${pkgJsonPath}`);
    }
  }
}

console.log('Version synchronization complete.');
