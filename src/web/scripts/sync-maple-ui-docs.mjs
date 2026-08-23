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

async function main() {
  assert(existsSync(docsRoot), `contract docs not found at ${docsRoot}`);
  const files = (await readdir(docsRoot)).filter((name) => name.endsWith('.md')).sort();
  assert(files.length > 0, `no contract docs in ${docsRoot}`);

  const manifest = [];
  for (const name of files) {
    const markdown = await readFile(resolve(docsRoot, name), 'utf8');
    const slug = name.replace(/\.md$/, '');
    manifest.push({ slug, title: titleOf(markdown, slug) });
  }
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

  if (checkOnly) {
    for (const name of files) {
      const source = await readFile(resolve(docsRoot, name), 'utf8');
      const copy = await readFile(resolve(outRoot, name), 'utf8');
      assert(source === copy, `${name}: copy differs from docs source — run maple-ui:sync`);
    }
    const manifestCopy = await readFile(resolve(outRoot, 'manifest.json'), 'utf8');
    assert(manifestCopy === manifestJson, 'manifest.json is stale — run maple-ui:sync');
    console.log(`maple-ui docs check OK (${files.length} contracts)`);
    return;
  }

  await rm(outRoot, { recursive: true, force: true });
  await mkdir(outRoot, { recursive: true });
  for (const name of files) {
    const markdown = await readFile(resolve(docsRoot, name), 'utf8');
    await writeFile(resolve(outRoot, name), markdown);
  }
  await writeFile(resolve(outRoot, 'manifest.json'), manifestJson);
  console.log(`maple-ui docs synced (${files.length} contracts) -> ${outRoot}`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
