// check-maple-ui-adoption.mjs — MW1 (ticket #3020) adoption ratchet.
//
// The Settings surface (src/web/projects/maple/src/app/settings/) has been
// fully migrated off hand-rolled <button> markup and the shared
// btn-primary/btn-ghost CSS classes onto the Maple UI design-system
// components (mui-button, mui-input, mui-checkbox, mui-settings-row, …).
// This script is the enforcement ratchet the migration plan calls for: it
// fails the build if a raw <button> element or a btn-primary/btn-ghost class
// re-enters any migrated directory, so a future change can't silently regress
// back to hand-rolled markup.
//
// Scope is deliberately narrow — only the directories this wave (MW1)
// actually migrated. Later waves (MW2+) add their own directories here as
// they land, the same incremental-ratchet pattern as the rest of this repo's
// ratchet scripts (see check_budget_ratchet.py, check-budget-headroom.sh).

import { readdir, readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATED_DIRECTORIES = [
  resolve(fileURLToPath(new URL('../projects/maple/src/app/settings', import.meta.url))),
];

const TEMPLATE_EXTENSIONS = new Set(['.html']);

// A raw <button ...> element — case-sensitive, matches the opening tag only
// (mui-button, mui-list-row, etc. never start with "<button").
const RAW_BUTTON_PATTERN = /<button\b/;

// The two legacy shared CSS classes this wave deleted (settings-chrome.scss's
// `.btn-primary` / `.btn-ghost` mixin, plus every per-component duplicate).
// Matches the class in either `class="btn-ghost ..."` / `class="... btn-ghost"`
// position, or a bare SCSS/HTML class-selector token.
const LEGACY_BTN_CLASS_PATTERN = /\bbtn-(primary|ghost)\b/;

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return collectFiles(path);
      return TEMPLATE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
    }),
  );
  return files.flat();
}

async function findViolations(directory) {
  const files = await collectFiles(directory);
  const violations = [];

  for (const path of files) {
    const source = await readFile(path, 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      if (RAW_BUTTON_PATTERN.test(line)) {
        violations.push(`${path}:${index + 1}: raw <button> element — use mui-button instead`);
      }
      if (LEGACY_BTN_CLASS_PATTERN.test(line)) {
        violations.push(
          `${path}:${index + 1}: legacy btn-primary/btn-ghost class — use mui-button's ` +
            `\`variant\` input instead`,
        );
      }
    });
  }

  return violations;
}

const allViolations = (await Promise.all(MIGRATED_DIRECTORIES.map(findViolations))).flat();

if (allViolations.length > 0) {
  console.error('Maple UI adoption check failed:\n');
  for (const violation of allViolations) console.error(`  ${violation}`);
  console.error(
    `\n${allViolations.length} violation(s) in ${MIGRATED_DIRECTORIES.length} migrated ` +
      'director(y/ies). See docs/superpowers/plans/2026-08-25-maple-ui-adoption-migration.md.',
  );
  process.exit(1);
}

console.log(
  `Maple UI adoption check passed (${MIGRATED_DIRECTORIES.length} migrated director(y/ies) clean).`,
);
