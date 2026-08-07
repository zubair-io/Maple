// batch-rename.types.ts — view-model + wire types for the Batch Rename
// dialog (#2640). Mirrors `src/api/src/routes/assets/batch-rename.ts` and
// `src/api/src/library/batch-rename.ts` (#2636), which are the source of
// truth for the field shapes; see those files' module docs for the
// sequential-application / partial-failure contract this UI surfaces.

/** One file selected for a batch rename, as the caller (grid multi-select)
 * knows it — `address` is the `slug:relPath` id the rest of the app uses;
 * the batch-rename endpoints want a Mongo id instead, so the dialog resolves
 * `address` → Mongo id itself (`BatchRenameService.resolveIds`) before
 * calling preview/apply. */
export interface BatchRenameSelection {
  address: string;
  filename: string;
}

export type BatchRenameCollisionPolicy = 'auto-suffix' | 'skip' | 'replace' | 'keep-both';

export interface BatchRenameTemplateOptions {
  template: string;
  sequenceStart: number;
  sequencePadWidth: number;
}

/** One `address` resolved (or not) to the Mongo id the batch-rename
 * endpoints require. `id: null` means resolution failed (e.g. the address
 * no longer names a live asset) — `BatchRenameService` still reports that
 * row in preview/apply results as an error rather than silently dropping
 * it, so a partial-failure summary always accounts for every selected
 * file. */
export interface ResolvedBatchRenameId {
  address: string;
  filename: string;
  id: string | null;
}

/** One row of the live before→after preview list. */
export interface BatchRenamePreviewItem {
  address: string;
  oldFilename: string | null;
  newFilename: string | null;
  error: string | null;
  /** True when an earlier row in this same preview rendered the identical
   * destination filename — a self-collision within the batch itself, not a
   * disk collision (that's `collision` at apply time). Surfaced so the user
   * can see it before applying. */
  duplicate: boolean;
}

export type BatchRenameItemResult =
  | {
      address: string;
      kind: 'relocated';
      oldFilename: string;
      newFilename: string;
      renamedOnCollision: boolean;
      extensionChanged: boolean;
    }
  | { address: string; kind: 'skipped'; reason: string }
  | { address: string; kind: 'not-found' }
  | { address: string; kind: 'invalid'; error: string }
  | { address: string; kind: 'error'; error: string };

export interface BatchRenameSummary {
  total: number;
  relocated: number;
  skipped: number;
  failed: number;
}

export interface BatchRenameApplyResult {
  summary: BatchRenameSummary;
  results: BatchRenameItemResult[];
}

/** Template-token quick-insert legend shown next to the template field.
 * Mirrors `raw-core`'s `filename` module doc (`{original}`, `{n}`,
 * `{date:FORMAT}`, `{ext}`) — kept as a plain data table here (not
 * generated) since it's UI copy, not a value the pipeline needs to agree
 * with byte-for-byte. */
export interface BatchRenameTokenHelp {
  token: string;
  label: string;
}

export const BATCH_RENAME_TOKEN_HELP: readonly BatchRenameTokenHelp[] = [
  { token: '{original}', label: 'Original filename (no extension)' },
  { token: '{n}', label: 'Sequence number' },
  { token: '{date:%Y-%m-%d}', label: 'Capture date (EXIF), strftime-style' },
  { token: '{ext}', label: 'Original extension' },
];

export const DEFAULT_BATCH_RENAME_TEMPLATE = '{original}';
