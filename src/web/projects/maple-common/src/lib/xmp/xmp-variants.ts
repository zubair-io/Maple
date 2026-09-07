// xmp-variants.ts — nested-element XMP I/O for variants, snapshots and
// semantic history (#2437). TypeScript mirror of raw-core's
// `xmp/variants/` and Swift's `XMPSerialization+Variants.swift`;
// `docs/xmp-canonical-format.md` § "Variants, snapshots and history" is the
// contract all three implement.
//
// Three blocks, all in Maple's own `papp:` namespace:
//
//   <papp:Variants>   the primary sidecar's manifest of alternate branches
//   <papp:Snapshots>  named immutable checkpoints inside this variant
//   <papp:History>    the bounded semantic action log
//
// Snapshots deliberately do NOT reuse Adobe's `crs:Snapshots`: a foreign
// Lightroom sidecar's own snapshot stack rides the unknown-node passthrough
// pipe byte-for-byte, and writing Maple snapshots into that element would
// both collide with the foreign stack and break the "a Maple writer must not
// destroy anything it does not understand" rule.
//
// A snapshot and a history entry each carry their COMPLETE adjustment state
// (attributes plus nested point tone curves), not a delta against a periodic
// checkpoint. Every field is written omit-on-default, so "complete state" for
// a real edit is the handful of attributes the photographer actually moved; a
// delta codec would be a second wire encoding of the same schema for a size
// win omit-on-default already delivers, and it would make only checkpoints
// exactly restorable where full state makes every retained entry so.
// Boundedness is `HISTORY_CAP` plus `compactHistory`, and compaction cannot
// change what the image renders as: the rendered state is the document's own
// top-level attributes, never the log.

import { defaultAdjustmentModel, type AdjustmentModel } from '../models/adjustment-model';
import { managedXmpName } from './xmp-dom-utils';
import { escapeXmpAttr } from './xmp-serializer-parts';
import { sortCanonicalAttributes } from './xmp-canonical';
import { toneCurveBlocks, parseToneCurveElement, toneCurveElementKey } from './xmp-tone-curves';
import { walkAdjustmentAttributes, applyLegacyAliases } from './xmp-adjustment-walk';
import { finalizeCrop } from './xmp-crop';

/** The reserved id of the branch stored in the base `<stem>.xmp` sidecar. */
export const PRIMARY_VARIANT_ID = 'primary';

/** Cap on the persisted history log, matching `UNDO_STACK_CAP`. */
export const HISTORY_CAP = 32;

/** Filename segment marking a variant sidecar, before the `.xmp` suffix. */
const VARIANT_MARKER = '.v-';

const VARIANTS_CONTAINER = 'papp:Variants';
const SNAPSHOTS_CONTAINER = 'papp:Snapshots';
const HISTORY_CONTAINER = 'papp:History';

/** One entry in the primary sidecar's variant manifest. */
export interface VariantRecord {
  readonly id: string;
  readonly name: string;
  readonly created: string;
  /** Tombstone — a deleted variant keeps its entry and its sidecar so
   * "recover" is a flag flip rather than an unrecoverable unlink. */
  readonly deleted: boolean;
}

/** A named, immutable checkpoint inside one variant. */
export interface SidecarSnapshot {
  readonly name: string;
  readonly created: string;
  readonly model: AdjustmentModel;
}

/** One committed, user-visible action. `kind` is the `EditTransaction`
 * action class verbatim, kept as a string so a sidecar written by a newer
 * build carrying an unknown class round-trips instead of failing. */
export interface SidecarHistoryEntry {
  readonly kind: string;
  readonly description: string;
  readonly time: string;
  readonly model: AdjustmentModel;
}

/** Everything a sidecar carries that is about the edit rather than part of it. */
export interface SidecarVariants {
  /** This sidecar's own branch id — empty for the primary sidecar. */
  readonly variantId: string;
  readonly variantName: string;
  /** The manifest, written in the primary sidecar only. */
  readonly variants: readonly VariantRecord[];
  readonly snapshots: readonly SidecarSnapshot[];
  readonly history: readonly SidecarHistoryEntry[];
}

export function emptySidecarVariants(): SidecarVariants {
  return { variantId: '', variantName: '', variants: [], snapshots: [], history: [] };
}

export function isEmptySidecarVariants(v: SidecarVariants | undefined): boolean {
  return (
    !v ||
    (v.variantId === '' &&
      v.variantName === '' &&
      v.variants.length === 0 &&
      v.snapshots.length === 0 &&
      v.history.length === 0)
  );
}

/**
 * True for an id that is safe to embed in a filename and stable across the
 * four platforms' path layers: 1–32 characters of ASCII letters, digits, `_`
 * or `-`, and not the reserved primary id. Deliberately tighter than "any
 * string": the id IS part of a path, so a separator, a dot, or a non-ASCII
 * codepoint would make one manifest resolve to different files on different
 * filesystems.
 */
export function isValidVariantId(id: string): boolean {
  return (
    id.length > 0 && id.length <= 32 && id !== PRIMARY_VARIANT_ID && /^[A-Za-z0-9_-]+$/.test(id)
  );
}

/** The sidecar filename for `id`, given the primary sidecar's filename.
 * `null` when the id is unusable or `primaryName` is not a `.xmp` name. */
export function variantSidecarName(primaryName: string, id: string): string | null {
  if (!isValidVariantId(id) || !primaryName.endsWith('.xmp')) return null;
  return `${primaryName.slice(0, -'.xmp'.length)}${VARIANT_MARKER}${id}.xmp`;
}

/** Inverse of `variantSidecarName`. `null` for the primary sidecar and for a
 * sibling whose marker segment is not an id this build would ever write — an
 * unrecognised neighbour stays a stray file rather than becoming a variant. */
export function parseVariantSidecarName(
  name: string,
): { readonly primaryName: string; readonly id: string } | null {
  if (!name.endsWith('.xmp')) return null;
  const stem = name.slice(0, -'.xmp'.length);
  const marker = stem.lastIndexOf(VARIANT_MARKER);
  if (marker < 0) return null;
  const id = stem.slice(marker + VARIANT_MARKER.length);
  if (!isValidVariantId(id)) return null;
  return { primaryName: `${stem.slice(0, marker)}.xmp`, id };
}

/** Drop the oldest entries beyond `HISTORY_CAP`, newest last. */
export function compactHistory<T>(entries: readonly T[]): readonly T[] {
  return entries.length > HISTORY_CAP ? entries.slice(entries.length - HISTORY_CAP) : entries;
}

/** The block `child` opens, or undefined when it is not one of the three.
 * Used by the passthrough collector to keep these children out of the
 * unknown-node bucket, which would otherwise emit them twice. */
export function variantContainerKind(
  child: Element,
): 'variants' | 'snapshots' | 'history' | undefined {
  switch (managedXmpName(child)) {
    case VARIANTS_CONTAINER:
      return 'variants';
    case SNAPSHOTS_CONTAINER:
      return 'snapshots';
    case HISTORY_CONTAINER:
      return 'history';
    default:
      return undefined;
  }
}

const attr = (el: Element, name: string): string =>
  el.getAttributeNS('http://ns.justmaple.app/photo/1.0/', name.slice('papp:'.length)) ??
  el.getAttributeNS('http://ns.justmaple.app/1.0/', name.slice('papp:'.length)) ??
  el.getAttribute(name) ??
  '';

/** The `rdf:Description` entries of one container, in document order. */
function entryDescriptions(container: Element): Element[] {
  return Array.from(container.getElementsByTagName('*')).filter(
    (el) => el.localName === 'Description',
  );
}

/**
 * Read one entry's complete adjustment state: the schema attributes on its
 * own `rdf:Description` plus any nested point tone curves. `wbScaleVersion`
 * is inherited from the document, because an entry's state was authored in
 * the same slider scale as the document that carries it.
 */
function entryModel(el: Element, wbScaleVersion: number): AdjustmentModel {
  const hasCropAttr = el.getAttributeNS('http://ns.adobe.com/camera-raw-settings/1.0/', 'HasCrop');
  const hasCrop = hasCropAttr === 'True' || hasCropAttr === 'true';
  const { model, canonicallyApplied, legacyDeferred, cropAcc } = walkAdjustmentAttributes(
    el,
    hasCrop,
  );
  applyLegacyAliases(model, legacyDeferred, canonicallyApplied);
  const crop = finalizeCrop(cropAcc);
  if (crop) model.crop = crop;
  for (const child of Array.from(el.children)) {
    const key = toneCurveElementKey(child);
    if (key) model[key] = parseToneCurveElement(child);
  }
  return { ...defaultAdjustmentModel(), ...model, wbScaleVersion };
}

/**
 * Parse the three blocks off a merged `rdf:Description`, plus this sidecar's
 * own `papp:VariantId` / `papp:VariantName` identity attributes.
 */
export function parseVariantBlocks(desc: Element, wbScaleVersion: number): SidecarVariants {
  const containers = Array.from(desc.children);
  const of = (kind: 'variants' | 'snapshots' | 'history'): Element[] =>
    containers.filter((c) => variantContainerKind(c) === kind).flatMap(entryDescriptions);

  const variants = of('variants')
    .map((el) => ({
      id: attr(el, 'papp:VariantId'),
      name: attr(el, 'papp:VariantName'),
      created: attr(el, 'papp:VariantCreated'),
      deleted: /^(1|true|on)$/i.test(attr(el, 'papp:VariantDeleted')),
    }))
    .filter((record) => isValidVariantId(record.id));

  const snapshots = of('snapshots').map((el) => ({
    name: attr(el, 'papp:SnapshotName'),
    created: attr(el, 'papp:SnapshotCreated'),
    model: entryModel(el, wbScaleVersion),
  }));

  const history = compactHistory(
    of('history').map((el) => ({
      kind: attr(el, 'papp:HistoryKind'),
      description: attr(el, 'papp:HistoryDescription'),
      time: attr(el, 'papp:HistoryTime'),
      model: entryModel(el, wbScaleVersion),
    })),
  );

  return {
    variantId: attr(desc, 'papp:VariantId'),
    variantName: attr(desc, 'papp:VariantName'),
    variants,
    snapshots,
    history,
  };
}

/** A rendered `name="value"` attribute part, or '' when the value is empty. */
const part = (name: string, value: string): string =>
  value.length > 0 ? `${name}="${escapeXmpAttr(value)}"` : '';

/**
 * Emit the three blocks for `variants`, each line prefixed so the container
 * element sits at `indent` — same contract as `toneCurveBlocks`. Returns the
 * empty string when all three are empty, so a sidecar that never branched
 * keeps the bytes it had before this ticket existed.
 *
 * `stateParts` renders one model's canonical attributes; the caller passes
 * the serializer's own field emitters so an entry's state is spelled exactly
 * the way the document body spells it.
 */
export function variantBlocks(
  variants: SidecarVariants | undefined,
  indent: string,
  stateParts: (model: AdjustmentModel) => readonly string[],
): string {
  if (!variants) return '';
  const blocks = [
    container(
      VARIANTS_CONTAINER,
      variants.variants.map((v) => ({
        header: [
          part('papp:VariantId', v.id),
          part('papp:VariantName', v.name),
          part('papp:VariantCreated', v.created),
          v.deleted ? 'papp:VariantDeleted="True"' : '',
        ],
        model: undefined,
      })),
      indent,
      stateParts,
    ),
    container(
      SNAPSHOTS_CONTAINER,
      variants.snapshots.map((s) => ({
        header: [part('papp:SnapshotName', s.name), part('papp:SnapshotCreated', s.created)],
        model: s.model,
      })),
      indent,
      stateParts,
    ),
    container(
      HISTORY_CONTAINER,
      variants.history.map((h) => ({
        header: [
          part('papp:HistoryKind', h.kind),
          part('papp:HistoryDescription', h.description),
          part('papp:HistoryTime', h.time),
        ],
        model: h.model,
      })),
      indent,
      stateParts,
    ),
  ];
  return blocks.filter((b) => b.length > 0).join('\n');
}

function container(
  name: string,
  entries: ReadonlyArray<{ header: readonly string[]; model: AdjustmentModel | undefined }>,
  indent: string,
  stateParts: (model: AdjustmentModel) => readonly string[],
): string {
  if (entries.length === 0) return '';
  const i1 = `${indent}  `;
  const i2 = `${indent}    `;
  const i3 = `${indent}      `;
  const i4 = `${indent}        `;
  const lines = [`${indent}<${name}>`, `${i1}<rdf:Seq>`];
  for (const entry of entries) {
    const attrs = sortCanonicalAttributes(
      [...entry.header, ...(entry.model ? stateParts(entry.model) : [])].filter(
        (p) => p.length > 0,
      ),
    );
    const curves = entry.model ? toneCurveBlocks(entry.model, i4) : '';
    lines.push(`${i2}<rdf:li>`, `${i3}<rdf:Description`);
    lines.push(...attrs.map((a) => `${i4}${a}`));
    if (curves.length === 0) {
      lines[lines.length - 1] += '/>';
    } else {
      lines[lines.length - 1] += '>';
      lines.push(curves, `${i3}</rdf:Description>`);
    }
    lines.push(`${i2}</rdf:li>`);
  }
  lines.push(`${i1}</rdf:Seq>`, `${indent}</${name}>`);
  return lines.join('\n');
}
