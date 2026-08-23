// Copies the Maple UI component-contract docs into maple-syrup's public
// assets so the hosted /maple-ui page can render them. Ticket #3000.
//
// Source of truth: docs/design/maple-ui/components/*.md (linted by the
// maple-ui-contracts CI job). The copies under projects/maple-syrup/public/
// are gitignored build artifacts — this script runs from the prestart:syrup /
// prebuild:syrup hooks so a dev server or production build always ships the
// current contracts. `--check` verifies existing copies match the source
// (same convention as sync-brand-assets.mjs).

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webRoot, '../..');
const docsRoot = resolve(repoRoot, 'docs/design/maple-ui/components');
const outRoot = resolve(webRoot, 'projects/maple-syrup/public/maple-ui');
const checkOnly = process.argv.includes('--check');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** First `# ` heading in the doc, e.g. `# List Row` -> `List Row`. */
function titleOf(markdown, slug) {
  const heading = markdown.split('\n').find((line) => line.startsWith('# '));
  return heading ? heading.slice(2).trim() : slug;
}

/** Reads every contract doc, returning `[fileName, markdown]` pairs. */
async function readContracts() {
  assert(existsSync(docsRoot), `contract docs not found at ${docsRoot}`);
  const files = (await readdir(docsRoot)).filter((name) => name.endsWith('.md')).sort();
  assert(files.length > 0, `no contract docs in ${docsRoot}`);
  return Promise.all(
    files.map(async (name) => [name, await readFile(resolve(docsRoot, name), 'utf8')]),
  );
}

function manifestFor(contracts) {
  const entries = contracts.map(([name, markdown]) => {
    const slug = name.replace(/\.md$/, '');
    return { slug, title: titleOf(markdown, slug) };
  });
  return `${JSON.stringify(entries, null, 2)}\n`;
}

async function checkCopies(contracts, manifestJson) {
  for (const [name, markdown] of contracts) {
    const copy = await readFile(resolve(outRoot, name), 'utf8');
    assert(markdown === copy, `${name}: copy differs from docs source — run maple-ui:sync`);
  }
  const manifestCopy = await readFile(resolve(outRoot, 'manifest.json'), 'utf8');
  assert(manifestCopy === manifestJson, 'manifest.json is stale — run maple-ui:sync');
  console.log(`maple-ui docs check OK (${contracts.length} contracts)`);
}

async function writeCopies(contracts, manifestJson) {
  await rm(outRoot, { recursive: true, force: true });
  await mkdir(outRoot, { recursive: true });
  for (const [name, markdown] of contracts) {
    await writeFile(resolve(outRoot, name), markdown);
  }
  await writeFile(resolve(outRoot, 'manifest.json'), manifestJson);
  console.log(`maple-ui docs synced (${contracts.length} contracts) -> ${outRoot}`);
}

async function main() {
  const contracts = await readContracts();
  const manifestJson = manifestFor(contracts);
  await (checkOnly ? checkCopies(contracts, manifestJson) : writeCopies(contracts, manifestJson));
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
