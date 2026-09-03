// edit-transaction.ts — the one object every committed editor action becomes
// (#2432). Web mirror of Apple's `EditTransaction` (MapleCore/Editor/
// EditTransaction.swift): same fields, same kinds, same diff format, same
// wire form — hand-mirrored per the design spec's decision, pinned equal by
// the parity literal in `edit-transaction.spec.ts`.
//
// The diff is expressed in canonical XMP attribute keys and values — the
// exact bytes the sidecar writer emits — so a transaction on either platform
// over the same two models produces an identical diff
// (docs/xmp-canonical-format.md is the contract that makes that true).

import type { AdjustmentModel } from '../models/adjustment-model';
import type { XmpSerializerService } from '../xmp/xmp-serializer.service';

/** Bumped when the serialized form changes shape. Mirrors Swift's
 * `EditTransaction.serializationVersion`. */
export const EDIT_TRANSACTION_VERSION = 1;

/** The action classes the contract covers. `mask` / `repair` / `variant`
 * are declared so the surfaces that ship them route through the same
 * object; nothing constructs them on Web today. */
export type EditTransactionKind =
  | 'adjustment'
  | 'auto'
  | 'crop'
  | 'paste'
  | 'preset'
  | 'reset'
  | 'mask'
  | 'repair'
  | 'variant';

/** What a committed change forces the render path to redo. */
export type InvalidationScope = 'none' | 'crop' | 'develop' | 'decode';

/** One changed canonical sidecar attribute; `null` = absent on that side. */
export interface SidecarFieldChange {
  readonly key: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface EditTransaction {
  /** Monotonic per bound asset; stable for the binding's lifetime. */
  readonly id: number;
  readonly kind: EditTransactionKind;
  /** User-visible, announced to assistive technology on commit. */
  readonly description: string;
  readonly before: AdjustmentModel;
  readonly after: AdjustmentModel;
  /** Sorted by key; deterministic for a given (before, after). */
  readonly diff: readonly SidecarFieldChange[];
  readonly invalidation: InvalidationScope;
}

/** The fields whose change forces a re-decode (the decode-product family). */
const DECODE_INPUT_KEYS = [
  'chromaPrefilter',
  'deepDenoise',
  'hotPixelSuppression',
  'lensProfileEnable',
  'lensCorrectionDistortion',
  'lensCorrectionCa',
  'lensCorrectionVignetting',
  'captureSharpeningAmount',
  'captureSharpeningSigma',
] as const satisfies readonly (keyof AdjustmentModel)[];

/** JSON with recursively sorted object keys — a canonical, comparable form. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const body = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
    return `{${body.join(',')}}`;
  }
  return JSON.stringify(value);
}

function modelsEqual(a: AdjustmentModel, b: AdjustmentModel): boolean {
  return stableStringify(a) === stableStringify(b);
}

/** Single classifier for the transaction ring — mirrors Swift's
 * `InvalidationScope.classify(from:to:)`. */
export function classifyInvalidation(a: AdjustmentModel, b: AdjustmentModel): InvalidationScope {
  if (modelsEqual(a, b)) return 'none';
  if (DECODE_INPUT_KEYS.some((k) => stableStringify(a[k]) !== stableStringify(b[k]))) {
    return 'decode';
  }
  const stripA = { ...a, crop: undefined };
  const stripB = { ...b, crop: undefined };
  return stableStringify(stripA) === stableStringify(stripB) ? 'crop' : 'develop';
}

/** The attributes that differ, sorted by key. */
export function sidecarDiff(
  serializer: XmpSerializerService,
  a: AdjustmentModel,
  b: AdjustmentModel,
): SidecarFieldChange[] {
  const before = serializer.modelAttributes(a);
  const after = serializer.modelAttributes(b);
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  return keys.flatMap((key) => {
    const x = before.get(key) ?? null;
    const y = after.get(key) ?? null;
    return x === y ? [] : [{ key, before: x, after: y }];
  });
}

/** Build a transaction; `null` when the models are semantically identical —
 * a no-op is not an action and must not enter history. */
export function makeEditTransaction(
  serializer: XmpSerializerService,
  input: {
    id: number;
    kind: EditTransactionKind;
    description: string;
    before: AdjustmentModel;
    after: AdjustmentModel;
  },
): EditTransaction | null {
  const diff = sidecarDiff(serializer, input.before, input.after);
  const invalidation = classifyInvalidation(input.before, input.after);
  if (diff.length === 0 && invalidation === 'none') return null;
  return { ...input, diff, invalidation };
}

/** The bounded, versioned wire form: no model snapshots, only the semantic
 * diff. Byte-identical to Swift's `serializedJSON()` for the same edit. */
export function serializeEditTransaction(tx: EditTransaction): string {
  return stableStringify({
    version: EDIT_TRANSACTION_VERSION,
    id: tx.id,
    kind: tx.kind,
    description: tx.description,
    invalidation: tx.invalidation,
    diff: tx.diff.map((c) => ({ key: c.key, before: c.before, after: c.after })),
  });
}
