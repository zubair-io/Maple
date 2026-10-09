// Cross-container layer order (#4427): the XMP wire form groups corrections by
// container kind, so a stack that interleaves kinds stamps every correction
// with its model index in `papp:LayerOrder`, and the reader restores that
// order only when every modeled correction carries a key. Mirrors raw-core's
// `serialize_local_adjustments` / `LocalAdjustmentsWalker::finish`.

import type { LocalAdjustment, LocalMask } from '../models/local-adjustment';
import { LAYER_ORDER_ATTRIBUTE } from '../generated/local-mask-wire.generated';
import { attrOf } from './xmp-dom-utils';
import { maskCoord } from './xmp-local-adjustments-brush';

export type LocalAdjustmentContainerKind = 'linear' | 'radial' | 'brush' | 'group';

/** Container element per mask kind, in canonical emit order. */
export const CONTAINERS: ReadonlyArray<{ tag: string; kind: LocalAdjustmentContainerKind }> = [
  { tag: 'crs:GradientBasedCorrections', kind: 'linear' },
  { tag: 'crs:CircularGradientBasedCorrections', kind: 'radial' },
  { tag: 'papp:BrushCorrections', kind: 'brush' },
  { tag: 'crs:MaskGroupBasedCorrections', kind: 'group' },
];

/** Which container a mask rides: bitmap and everywhere share the group container. */
export const containerKindOf = (mask: LocalMask): LocalAdjustmentContainerKind =>
  mask.kind === 'linear' || mask.kind === 'radial' || mask.kind === 'brush' ? mask.kind : 'group';

const containerRank = (layer: LocalAdjustment): number =>
  CONTAINERS.findIndex(({ kind }) => kind === containerKindOf(layer.mask));

export type LayerOrderOf = (layer: LocalAdjustment) => number | undefined;

/** Each layer's model index when the stack interleaves container kinds, else no keys. */
export function layerOrderOf(layers: readonly LocalAdjustment[]): LayerOrderOf {
  const interleaved = layers.some(
    (layer, index) => index > 0 && containerRank(layers[index - 1]) > containerRank(layer),
  );
  if (!interleaved) return () => undefined;
  const indices = new Map(layers.map((layer, index) => [layer, index] as const).reverse());
  return (layer) => indices.get(layer);
}

export const layerOrderLines = (order: number | undefined, indent: string): string[] =>
  order === undefined ? [] : [`${indent}${LAYER_ORDER_ATTRIBUTE}="${maskCoord(order)}"`];

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** A `papp:LayerOrder` value as a key; anything but a finite decimal reads as absent. */
export function parseLayerOrder(value: string | null): number | undefined {
  const raw = value?.trim();
  const order = raw !== undefined && DECIMAL.test(raw) ? Number(raw) : undefined;
  return order !== undefined && Number.isFinite(order) ? order : undefined;
}

// Keyed by the parsed layer object so the two collection paths (direct
// containers and mask-group templates) need no extra plumbing to the sort.
const readOrders = new WeakMap<LocalAdjustment, number>();

/** Remember `description`'s `papp:LayerOrder` for `layer`. */
export function withReadLayerOrder(layer: LocalAdjustment, description: Element): LocalAdjustment {
  const order = parseLayerOrder(attrOf(description, [LAYER_ORDER_ATTRIBUTE]));
  if (order !== undefined) readOrders.set(layer, order);
  return layer;
}

/** The key `layer` was read with, if any. */
export const readLayerOrder = (layer: LocalAdjustment): number | undefined => readOrders.get(layer);

/** Stable-sort by the read keys when every layer has one; otherwise container order. */
export function inReadLayerOrder(layers: readonly LocalAdjustment[]): LocalAdjustment[] {
  const keyed = layers.map((layer) => ({ layer, order: readOrders.get(layer) }));
  if (keyed.length === 0 || keyed.some(({ order }) => order === undefined)) return [...layers];
  return keyed.sort((a, b) => a.order! - b.order!).map(({ layer }) => layer);
}
