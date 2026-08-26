// check-maple-ui-adoption.mjs — MW1 (ticket #3020) adoption ratchet,
// extended by MW2 (ticket #3029).
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
// Scope is deliberately narrow — only directories that are ENTIRELY clean
// (every template in the subtree, not just the one file a wave touched).
// MW2 (#3029) migrated `pano/pano-dialog.component` off its `pano-btn-*`
// clone family and its header close button onto `<mui-button>`, and that
// component is the only template under `lib/pano/` — the whole directory
// is clean, so it's added here. MW2 also touched raw buttons inside
// `drag-move/`, `trash/`, and `components/folder-tree/` (the
// `dmc-btn-*`/`mtd-btn-*`/`tdc-btn-*` clone families, plus the two dialogs
// that used to extend `DestructiveConfirmDialogBase`), but those
// directories each still hold OTHER, unmigrated raw-`<button>` templates
// outside this wave's scope (e.g.
// `folder-tree/folder-new-folder-dialog.component.html`,
// `trash/trash-toolbar.component.html`) — adding them here would
// false-positive against files nobody has migrated yet, so they wait for
// the wave that actually clears their siblings (MW3 info panel, MW4 browse
// shell, or a later KTLO pass). Later waves add their own directories here
// as they land, the same incremental-ratchet pattern as the rest of this
// repo's ratchet scripts (see check_budget_ratchet.py,
// check-budget-headroom.sh).

import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkFiles } from './lib/walk-files.mjs';

const MIGRATED_DIRECTORIES = [
  resolve(fileURLToPath(new URL('../projects/maple/src/app/settings', import.meta.url))),
  resolve(fileURLToPath(new URL('../projects/maple-common/src/lib/pano', import.meta.url))),
];

const TEMPLATE_EXTENSIONS = new Set(['.html']);
const STYLE_EXTENSIONS = new Set(['.scss']);

// A raw <button ...> element — case-sensitive, matches the opening tag only
// (mui-button, mui-list-row, etc. never start with "<button").
const RAW_BUTTON_PATTERN = /<button\b/;

// The two legacy shared CSS classes this wave deleted (settings-chrome.scss's
// `.btn-primary` / `.btn-ghost` mixin, plus every per-component duplicate).
// A plain word-boundary match (no anchor on `class="…"`) so it catches every
// way a template can reference the class, not just a literal `class`
// attribute: `class="btn-ghost …"`, `[ngClass]="{ 'btn-primary': cond }"`,
// and `[class.btn-primary]="cond"` all contain `btn-primary`/`btn-ghost` as
// a standalone word and all trip this pattern.
const LEGACY_BTN_CLASS_PATTERN = /\bbtn-(primary|ghost)\b/;

// The same two classes, but shaped to match a CSS *selector definition*
// rather than a usage — `.btn-primary` / `.btn-ghost` with the leading dot,
// as in `.btn-primary { … }`, `.btn-primary:hover { … }`, or `&.btn-ghost`.
// This is what would let the legacy class silently come back to life in a
// component's stylesheet even once every template consumer is migrated.
const LEGACY_BTN_SELECTOR_PATTERN = /\.btn-(primary|ghost)\b/;

/** Blanks out `<!-- ... -->` comment bodies (preserving line count/offsets)
 * so a rationale comment that has to *talk about* `<button>` or
 * `btn-ghost` — e.g. a `fallow-ignore-file` note explaining what a diff did
 * or didn't touch — doesn't itself trip the ratchet. */
function withoutHtmlComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/** Same idea for SCSS's `/* … *\/` and `// …` comment forms, so a mixin's
 * doc comment can reference the legacy class names by name (e.g. explaining
 * what it replaced) without tripping the ratchet. */
function withoutScssComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (line) => line.replace(/[^\n]/g, ' '));
}

async function findTemplateViolations(directory) {
  const files = await walkFiles(directory, (path) => TEMPLATE_EXTENSIONS.has(extname(path)));
  const violations = [];

  for (const path of files) {
    const source = await readFile(path, 'utf8');
    const lines = withoutHtmlComments(source).split('\n');
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

async function findStyleViolations(directory) {
  const files = await walkFiles(directory, (path) => STYLE_EXTENSIONS.has(extname(path)));
  const violations = [];

  for (const path of files) {
    const source = await readFile(path, 'utf8');
    const lines = withoutScssComments(source).split('\n');
    lines.forEach((line, index) => {
      if (LEGACY_BTN_SELECTOR_PATTERN.test(line)) {
        violations.push(
          `${path}:${index + 1}: legacy .btn-primary/.btn-ghost selector definition — delete ` +
            `it, mui-button's \`variant\` input replaces it`,
        );
      }
    });
  }

  return violations;
}

async function findViolations(directory) {
  const [templateViolations, styleViolations] = await Promise.all([
    findTemplateViolations(directory),
    findStyleViolations(directory),
  ]);
  return [...templateViolations, ...styleViolations];
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
