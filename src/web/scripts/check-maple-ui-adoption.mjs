// check-maple-ui-adoption.mjs — Maple UI adoption ratchet (MW1 ticket #3020,
// extended by MW2 ticket #3029, MW4 ticket #3031, and MW6 ticket #3047).
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
// (every template in the subtree, not just the one file a wave touched), or
// individual files ratcheted on their own because a sibling in the same
// directory is deliberately NOT migrated yet. Later waves add their own
// entries here as they land, the same incremental-ratchet pattern as the
// rest of this repo's ratchet scripts (see check_budget_ratchet.py,
// check-budget-headroom.sh).
//
// MW2 (#3029) migrated `pano/pano-dialog.component` off its `pano-btn-*`
// clone family and its header close button onto `<mui-button>`, and that
// component is the only template under `lib/pano/` — the whole directory is
// clean, so it's added here. MW2 also touched raw buttons inside
// `drag-move/`, `trash/`, and `components/folder-tree/` (the
// `dmc-btn-*`/`mtd-btn-*`/`tdc-btn-*` clone families, plus the two dialogs
// that used to extend `DestructiveConfirmDialogBase`), but at the time those
// directories each still held OTHER, unmigrated raw-`<button>` templates.
//
// MW4 (#3031, browse shell) fully migrated the directories below, but
// several folder-tree files stayed deliberately unmigrated this wave and so
// can't be ratcheted at the directory level yet:
//   - folder-context-menu.component.html — a `role="menu"`/`role="menuitem"`
//     popover; mui-button doesn't model menuitem semantics, and the
//     positioning model (literal x/y, not an anchored MuiPopover) doesn't
//     match mui-context-menu either. Left for a follow-up ticket.
//   - folder-trash-confirm-dialog.component.html — extends (or extended;
//     see MW2 above) `DestructiveConfirmDialogBase` from the confirm-dialog
//     family, which MW4 did not re-touch.
// Those files' *siblings* that MW4 did fully migrate (folder-tree-node,
// folder-tree-smart-row, folder-tree-footer, folder-rename-dialog,
// folder-new-folder-dialog) are ratcheted individually via MIGRATED_FILES
// instead — as is `trash/trash-node-row.component`, since `trash/` as a
// whole still holds other unmigrated templates (trash-list, trash-panel,
// trash-toolbar, trash-item-row, trash-delete-confirm-dialog,
// trash-status-banner).
//
// MW6 (#3047) migrated the asset-grid's per-tile chrome. `folder-tile/`
// (icon + text + a `role="button"` selection-ring div — no image, no raw
// <button> to begin with) is added below, directory-clean. The grid's
// photo tile moved to a NEW component, `components/asset-tile/` — not
// ratcheted, since its hover-reveal inline-rename trigger stays a raw
// <button> (matching the settings/toolbar-actions precedent for a button
// that mui-button doesn't fit visually). `components/asset-thumb/` — now
// the editor filmstrip's tile only — is likewise not ratcheted; that
// surface stays hand-rolled markup for the separate, perf-gated editor
// wave.

import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walkFiles } from './lib/walk-files.mjs';

const MIGRATED_DIRECTORIES = [
  resolve(fileURLToPath(new URL('../projects/maple/src/app/settings', import.meta.url))), // MW1
  resolve(fileURLToPath(new URL('../projects/maple-common/src/lib/pano', import.meta.url))), // MW2
  resolve(
    fileURLToPath(new URL('../projects/maple-common/src/lib/shells/browse-shell', import.meta.url)),
  ), // MW4 — includes the toolbar-actions/ subdirectory
  resolve(
    fileURLToPath(
      new URL('../projects/maple-common/src/lib/components/asset-grid', import.meta.url),
    ),
  ), // MW4
  resolve(
    fileURLToPath(
      new URL('../projects/maple-common/src/lib/components/drop-zone', import.meta.url),
    ),
  ), // MW4
  resolve(
    fileURLToPath(new URL('../projects/maple-common/src/lib/editor/copy-paste', import.meta.url)),
  ), // MW5 — paste-settings-dialog now composes mui-selective-paste-modal
  resolve(
    fileURLToPath(new URL('../projects/maple-common/src/lib/components/scopes', import.meta.url)),
  ), // MW5 — only histogram.component remains (composes mui-histogram); the
  //         other four legacy scopes (waveform/vectorscope/parade/
  //         scopes-container) were dead code, deleted this wave
  resolve(
    fileURLToPath(
      new URL('../projects/maple-common/src/lib/components/folder-tile', import.meta.url),
    ),
  ), // MW6 (#3047) — icon + text + selection-ring div, no raw <button> to begin with
];

// Individual files ratcheted on their own because a sibling in the same
// directory is deliberately NOT migrated (see the module doc above).
const MIGRATED_FILES = [
  '../projects/maple-common/src/lib/components/folder-tree/folder-tree-node.component.html',
  '../projects/maple-common/src/lib/components/folder-tree/folder-tree-smart-row.component.html',
  '../projects/maple-common/src/lib/components/folder-tree/folder-tree-footer.component.html',
  '../projects/maple-common/src/lib/components/folder-tree/folder-rename-dialog.component.html',
  '../projects/maple-common/src/lib/components/folder-tree/folder-rename-dialog.component.scss',
  '../projects/maple-common/src/lib/components/folder-tree/folder-new-folder-dialog.component.html',
  '../projects/maple-common/src/lib/components/folder-tree/folder-new-folder-dialog.component.scss',
  '../projects/maple-common/src/lib/trash/trash-node-row.component.html',
].map((path) => resolve(fileURLToPath(new URL(path, import.meta.url))));

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

function checkTemplateSource(path, source) {
  const violations = [];
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
  return violations;
}

function checkStyleSource(path, source) {
  const violations = [];
  const lines = withoutScssComments(source).split('\n');
  lines.forEach((line, index) => {
    if (LEGACY_BTN_SELECTOR_PATTERN.test(line)) {
      violations.push(
        `${path}:${index + 1}: legacy .btn-primary/.btn-ghost selector definition — delete ` +
          `it, mui-button's \`variant\` input replaces it`,
      );
    }
  });
  return violations;
}

async function checkFile(path) {
  const source = await readFile(path, 'utf8');
  if (TEMPLATE_EXTENSIONS.has(extname(path))) return checkTemplateSource(path, source);
  if (STYLE_EXTENSIONS.has(extname(path))) return checkStyleSource(path, source);
  return [];
}

async function findDirectoryViolations(directory) {
  const files = await walkFiles(
    directory,
    (path) => TEMPLATE_EXTENSIONS.has(extname(path)) || STYLE_EXTENSIONS.has(extname(path)),
  );
  const perFile = await Promise.all(files.map(checkFile));
  return perFile.flat();
}

const [directoryViolations, fileViolations] = await Promise.all([
  Promise.all(MIGRATED_DIRECTORIES.map(findDirectoryViolations)),
  Promise.all(MIGRATED_FILES.map(checkFile)),
]);
const allViolations = [...directoryViolations.flat(), ...fileViolations.flat()];
const scopeCount = MIGRATED_DIRECTORIES.length + MIGRATED_FILES.length;

if (allViolations.length > 0) {
  console.error('Maple UI adoption check failed:\n');
  for (const violation of allViolations) console.error(`  ${violation}`);
  console.error(
    `\n${allViolations.length} violation(s) across ${scopeCount} migrated ` +
      'director(y/ies)/file(s). See docs/superpowers/plans/2026-08-25-maple-ui-adoption-migration.md.',
  );
  process.exit(1);
}

console.log(`Maple UI adoption check passed (${scopeCount} migrated director(y/ies)/file(s) clean).`);
