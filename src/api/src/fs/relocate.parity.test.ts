/**
 * Cross-surface file-operation outcome-parity harness (#2633) — TS runner.
 *
 * Replays the declarative corpus at `test-fixtures/file-operations/cases.json`
 * against this repo's OWN relocate/validation/selector primitives
 * (`relocateFile` in `./relocate.ts`, `isSafeFilename` in
 * `../backup/path-formatter.ts`, `activeFileInfo` in
 * `../library/relocate-asset.ts`). The Swift runner
 * (`src/apple/Packages/MapleCore/Tests/MapleCoreTests/FileOperations/
 * RelocateParityTests.swift`) and the Windows runner
 * (`src/windows/Maple.WinUI.Tests/RelocateParityTests.cs`) replay the SAME
 * corpus against their own primitives — proving identical OUTCOMES without
 * sharing code, the same philosophy as the XMP golden-file corpus.
 *
 * A case whose `requires` capability this runner doesn't have (probed live,
 * never assumed) is skipped with an explicit `console.warn` naming the case
 * and the missing capability — never silently omitted. A case restricted by
 * `platforms` to exclude `"api"` is skipped the same loud way.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ObjectId } from 'mongodb';
import { relocateFile, type CollisionPolicy, type RelocateMode } from './relocate.ts';
import { isSafeFilename } from '../backup/path-formatter.ts';
import { activeFileInfo } from '../library/relocate-asset.ts';
import type { FileInfo } from '../db/schema.ts';

// ---------------------------------------------------------------------------
// Corpus loading — schema_version MUST be asserted (the #2628 corpus shipped
// this unasserted; #2633 review flagged it, this runner doesn't repeat it).
// ---------------------------------------------------------------------------

const EXPECTED_SCHEMA_VERSION = 1;

interface CorpusFile {
  path: string;
  content: string;
}
interface CorpusCase {
  name: string;
  kind: 'relocate' | 'folder-rename' | 'name-validation' | 'selector';
  description: string;
  platforms?: string[];
  requires: string[];
  setup?: { files?: CorpusFile[]; symlinks?: { path: string; target: string }[] };
  operation?: {
    source?: string;
    destDir?: string;
    destBasename?: string;
    mode?: RelocateMode;
    collision?: CollisionPolicy | 'fail';
    fault?: { type: string };
    folderPath?: string;
    newName?: string;
    name?: string;
    /** Non-sidecar companions to relocate alongside the primary (#2667) —
     * relative to the case's temp root, fed to `relocateFile`'s
     * `extraCompanionAbsPaths`. API-only (`requires: ["companion-file"]`). */
    companions?: string[];
  };
  fileinfo?: {
    path: string;
    filename: string;
    deleted_at: string | null;
    missing_since: string | null;
  }[];
  expected: {
    outcome?: 'relocated' | 'skipped' | 'error';
    renamedOnCollision?: boolean;
    sidecarFollowed?: boolean;
    /** Whether every listed `operation.companions` entry successfully
     * copied to the new location (#2667). */
    companionFollowed?: boolean;
    tree?: CorpusFile[];
    valid?: boolean;
    selectedIndex?: number;
  };
}
interface Corpus {
  schema_version: number;
  cases: CorpusCase[];
}

function findRepoRoot(): string {
  let dir = import.meta.dir;
  for (;;) {
    if (
      require('node:fs').existsSync(path.join(dir, 'CLAUDE.md')) &&
      require('node:fs').existsSync(path.join(dir, 'src'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('relocate.parity.test: could not find repo root');
    dir = parent;
  }
}

const corpusPath = path.join(findRepoRoot(), 'test-fixtures', 'file-operations', 'cases.json');
const corpus: Corpus = JSON.parse(await fs.readFile(corpusPath, 'utf8'));
if (corpus.schema_version !== EXPECTED_SCHEMA_VERSION) {
  throw new Error(
    `relocate.parity.test: cases.json schema_version ${corpus.schema_version} != expected ${EXPECTED_SCHEMA_VERSION} — the runner and the corpus have drifted apart, update one or the other before trusting any result below`,
  );
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function writeCase(root: string, rel: string, content: string): Promise<void> {
  const target = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

/** Every regular file under `root`, as POSIX-relative paths with content —
 * exhaustive, so a case's `expected.tree` must list EVERY surviving file,
 * not just the ones it cares about. Skips directories and any leaked
 * `.tmp.` publish artifact (a leaked temp is its own bug, but a distinct one
 * from what this harness targets, and Windows' own crash-safety tests
 * already assert temp cleanup directly). */
async function readTree(root: string): Promise<CorpusFile[]> {
  const out: CorpusFile[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && !entry.name.includes('.tmp.')) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        out.push({ path: rel, content: await fs.readFile(abs, 'utf8') });
      }
    }
  }
  await walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function assertTree(actual: CorpusFile[], expected: CorpusFile[] | undefined, label: string): void {
  if (!expected) return;
  const sortedExpected = [...expected].sort((a, b) => a.path.localeCompare(b.path));
  expect(actual, `${label}: resulting file tree`).toEqual(sortedExpected);
}

/** Probed live (write `a`, stat `A`) rather than assumed from `process.platform`
 * — CI can mount a case-sensitive volume on any OS, and this harness must
 * never guess.
 *
 * Synchronous, and evaluated once at module load, because the result is needed
 * at test-COLLECTION time (see `KNOWN_FAILURES`), not just inside a test body.
 * A `test.failing` marking has to be decided before the test runs, and an async
 * probe cannot inform that choice. */
const CASE_INSENSITIVE_FS: boolean = (() => {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'relocate-parity-probe-'));
  try {
    fsSync.writeFileSync(path.join(dir, 'a'), 'x');
    return fsSync.existsSync(path.join(dir, 'A'));
  } finally {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
})();

function probeCaseInsensitiveFs(): boolean {
  return CASE_INSENSITIVE_FS;
}

/** Whether this case runs at all: `platforms` (if present) must include
 * `"api"`. Returns a skip reason string, or `null` when it should run. */
function platformSkipReason(c: CorpusCase): string | null {
  if (c.platforms && !c.platforms.includes('api')) {
    return `platforms=[${c.platforms.join(',')}] excludes "api"`;
  }
  return null;
}

/** Whether every `requires` capability this case lists is available right
 * now. Returns a skip reason string, or `null` when it should run. */
async function requiresSkipReason(c: CorpusCase): Promise<string | null> {
  for (const cap of c.requires) {
    switch (cap) {
      case 'symlinks':
      case 'posix-permissions':
      case 'multi-location-fileinfo':
      case 'companion-file':
        continue; // always available to the Bun/API runner on macOS+Linux
      case 'case-insensitive-fs':
        if (!probeCaseInsensitiveFs()) return 'case-insensitive-fs: temp volume is case-sensitive';
        continue;
      default:
        return `unknown capability "${cap}"`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-kind execution
// ---------------------------------------------------------------------------

/** Materialise a case's `setup` (files, then symlinks) under `root`. */
async function materialiseSetup(root: string, setup: CorpusCase['setup']): Promise<void> {
  for (const f of setup?.files ?? []) {
    await writeCase(root, f.path, f.content);
  }
  for (const link of setup?.symlinks ?? []) {
    const linkAbs = path.join(root, ...link.path.split('/'));
    const targetAbs = path.join(root, ...link.target.split('/'));
    await fs.symlink(targetAbs, linkAbs);
  }
}

async function runRelocateCase(c: CorpusCase): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'relocate-parity-'));
  const chmodBack: string[] = [];
  try {
    await materialiseSetup(root, c.setup);

    const op = c.operation!;
    const sourceAbs = path.join(root, ...op.source!.split('/'));
    const destDirAbs = path.join(root, ...(op.destDir ?? '').split('/'));
    const destBasename = op.destBasename ?? path.basename(op.source!);
    const destAbs = path.join(destDirAbs, destBasename);

    if (op.fault?.type === 'readonly-source-dir') {
      const sourceDirAbs = path.dirname(sourceAbs);
      await fs.chmod(sourceDirAbs, 0o555);
      chmodBack.push(sourceDirAbs);
    }

    // TS has no "fail" CollisionPolicy value (see the corpus's own
    // divergence note on the skip/keep-both/fail cases) — every case
    // reaching this runner with collision:"fail" is already gated to
    // platforms excluding "api", so this cast is unreachable in practice,
    // not a silent behavior change.
    const outcome = await relocateFile({
      sourceAbsPath: sourceAbs,
      destAbsPath: destAbs,
      mode: op.mode!,
      collision: op.collision as CollisionPolicy,
      extraCompanionAbsPaths: op.companions?.map((rel) => path.join(root, ...rel.split('/'))),
    });

    assertRelocateOutcome(c, outcome);

    const tree = await readTree(root);
    assertTree(tree, c.expected.tree, c.name);
  } finally {
    for (const dir of chmodBack) await fs.chmod(dir, 0o755).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** The corpus's `expected.outcome` / `renamedOnCollision` / `sidecarFollowed`
 * assertions. Split out of `runRelocateCase` so that function stays within the
 * repo's complexity budget — the resulting-tree comparison is the primary
 * assertion, these are the metadata ones. */
function assertRelocateOutcome(
  c: CorpusCase,
  outcome: Awaited<ReturnType<typeof relocateFile>>,
): void {
  const actualOutcome =
    outcome.kind === 'relocated' ? 'relocated' : outcome.kind === 'skipped' ? 'skipped' : 'error';
  expect(actualOutcome, `${c.name}: outcome`).toBe(c.expected.outcome!);
  if (outcome.kind !== 'relocated') return;

  if (c.expected.renamedOnCollision !== undefined) {
    expect(outcome.renamedOnCollision, `${c.name}: renamedOnCollision`).toBe(
      c.expected.renamedOnCollision,
    );
  }
  if (c.expected.sidecarFollowed !== undefined) {
    expect(outcome.sidecarPaths.length > 0, `${c.name}: sidecarFollowed`).toBe(
      c.expected.sidecarFollowed,
    );
  }
  if (c.expected.companionFollowed !== undefined) {
    // "Followed" means EVERY listed `operation.companions` entry copied
    // successfully, not merely "at least one did" — a case with more than
    // one companion could otherwise report `companionFollowed: true` when
    // only some of them actually made it (found in review).
    const requested = c.operation?.companions?.length ?? 0;
    expect(outcome.companionPaths.length === requested, `${c.name}: companionFollowed`).toBe(
      c.expected.companionFollowed,
    );
  }
}

function runNameValidationCase(c: CorpusCase): void {
  const actual = isSafeFilename(c.operation!.name!);
  expect(actual, `${c.name}: isSafeFilename("${c.operation!.name}")`).toBe(c.expected.valid!);
}

function runSelectorCase(c: CorpusCase): void {
  const libraryId = new ObjectId();
  const fileinfo: FileInfo[] = c.fileinfo!.map((f) => ({
    path: f.path,
    filename: f.filename,
    library_id: libraryId,
    deleted_at: f.deleted_at,
    missing_since: f.missing_since,
  }));
  const expectedEntry =
    c.expected.selectedIndex === undefined ? null : c.fileinfo![c.expected.selectedIndex];
  // Compared as one value rather than field-by-field: a single `toEqual`
  // reports "wrong entry selected" directly, and keeps the optional-chaining
  // in one helper instead of spread across four assertions.
  expect(entryIdentity(activeFileInfo({ fileinfo })), `${c.name}: activeFileInfo`).toEqual(
    entryIdentity(expectedEntry),
  );
}

/** An entry's `(path, filename)`, or nulls when no entry was selected. */
function entryIdentity(e: { path: string; filename: string } | null | undefined): {
  path: string | null;
  filename: string | null;
} {
  return e ? { path: e.path, filename: e.filename } : { path: null, filename: null };
}

// ---------------------------------------------------------------------------
// Known TS-only divergences — confirmed bugs the corpus caught, filed and
// left failing per CLAUDE.md's "expect to find bugs" directive rather than
// weakened. `test.failing` keeps the case LOUD (it errors if the case ever
// starts passing without this entry being removed) instead of silently
// green or silently skipped.
// ---------------------------------------------------------------------------

interface KnownFailure {
  reason: string;
  /** Whether the divergence can actually manifest in THIS environment. A
   * `test.failing` case that is skipped (or that legitimately passes) counts
   * as an unexpected pass and fails the run — so a divergence that only
   * exists on some filesystems must only be marked on those filesystems. A
   * case gated by a `case-insensitive-fs` `requires` entry is the prototype:
   * on a case-SENSITIVE volume the case is skipped outright by that
   * requirement (see #2704's fix, which used `probeCaseInsensitiveFs` here
   * for exactly that reason before the underlying bug was closed) and must
   * NOT be marked as expected-to-fail. */
  appliesHere: () => boolean;
}

// #2704's case_only_rename_file_succeeds_with_sidecar entry lived here until
// relocateFile grew a case-only-rename special case — kept empty (not
// deleted) as the landing spot for the next confirmed TS-only divergence.
const KNOWN_FAILURES: Record<string, KnownFailure> = {};

// ---------------------------------------------------------------------------
// Dispatch — one `test()` per corpus case, skipped loudly when unsupported.
// ---------------------------------------------------------------------------

describe('cross-surface file-operation outcome parity (#2633)', () => {
  beforeAll(() => {
    console.log(`relocate.parity.test: loaded ${corpus.cases.length} cases from ${corpusPath}`);
  });

  for (const c of corpus.cases) {
    const known = KNOWN_FAILURES[c.name];
    const knownApplies = known !== undefined && known.appliesHere();
    const t = knownApplies ? test.failing : test;
    if (knownApplies) console.warn(`KNOWN FAILURE ${c.name}: ${known!.reason}`);
    t(c.name, async () => {
      const pReason = platformSkipReason(c);
      if (pReason) {
        console.warn(`SKIP ${c.name}: ${pReason}`);
        return;
      }
      const rReason = await requiresSkipReason(c);
      if (rReason) {
        console.warn(`SKIP ${c.name}: missing capability — ${rReason}`);
        return;
      }

      switch (c.kind) {
        case 'relocate':
          await runRelocateCase(c);
          return;
        case 'name-validation':
          runNameValidationCase(c);
          return;
        case 'selector':
          runSelectorCase(c);
          return;
        case 'folder-rename':
          // Every corpus 'folder-rename' case today restricts `platforms`
          // to exclude "api" (the API's folder rename is a Mongo-backed
          // library operation, not a pure filesystem primitive — see the
          // corpus's own note on case_only_rename_folder_succeeds_with_contents).
          // This branch exists so a FUTURE case without that restriction
          // fails loudly instead of silently reporting green.
          throw new Error(
            `${c.name}: kind "folder-rename" reached the API runner without a platforms exclusion — no API folder-rename primitive is wired into this harness yet`,
          );
      }
    });
  }
});
