// Corrections Maple keeps verbatim — a brush container it cannot read, opaque
// mask-group corrections — still hold a place in the layer stack (#4427). Their
// `papp:LayerOrder` keys are only ever read: every existing key stays stable
// across saves, and new or moved layers get a key between their neighbours.

import type { LocalAdjustment } from '../models/local-adjustment';
import { LAYER_ORDER_ATTRIBUTE } from '../generated/local-mask-wire.generated';
import { attrOf } from './xmp-dom-utils';
import { correctionDescriptions } from './xmp-crs-corrections';
import {
  inReadLayerOrder,
  layerOrderOf,
  parseLayerOrder,
  readLayerOrder,
  type LayerOrderOf,
} from './xmp-local-adjustment-order';
import type { AdjustmentModel } from '../models/adjustment-model';
import { maskCoord } from './xmp-local-adjustments-brush';

/** Keys of the correction descriptions in a container Maple re-emits verbatim. */
export const verbatimLayerOrders = (container: Element): number[] =>
  correctionDescriptions(container).flatMap((description) => {
    const key = parseLayerOrder(attrOf(description, [LAYER_ORDER_ATTRIBUTE]));
    return key === undefined ? [] : [key];
  });

/**
 * Restore the stack's read order, and keep each layer's read key only when a
 * verbatim correction needs the writer to order around it.
 */
export function orderLocalAdjustments(
  model: Partial<AdjustmentModel>,
  verbatim: readonly number[],
): void {
  if (!model.localAdjustments) return;
  model.localAdjustments = inReadLayerOrder(model.localAdjustments);
  if (verbatim.length === 0) return;
  for (const layer of model.localAdjustments) {
    const key = readLayerOrder(layer);
    if (key !== undefined) layer.xmpLayerOrder = key;
  }
}

interface Chain {
  length: number;
  previous?: number;
}

/**
 * Indices of a longest strictly increasing run of read keys, in model order.
 * Each link takes the earliest predecessor; ties on length keep the later end.
 */
function keptIndices(keys: ReadonlyArray<number | undefined>): ReadonlySet<number> {
  const chains = keys.reduce<Chain[]>((built, key, index) => {
    if (key === undefined) return [...built, { length: 0 }];
    const best = built.reduce<Chain>(
      (found, chain, earlier) => {
        const earlierKey = keys[earlier];
        return earlierKey !== undefined && earlierKey < key && chain.length > found.length
          ? { length: chain.length, previous: earlier }
          : found;
      },
      { length: 0 },
    );
    return [...built, { length: best.length + 1, previous: best.previous }];
  }, []);
  const lengths = chains.map((chain) => chain.length);
  const longest = Math.max(0, ...lengths);
  const walk = (index: number | undefined): number[] =>
    index === undefined ? [] : [...walk(chains[index].previous), index];
  return new Set(longest === 0 ? [] : walk(lengths.lastIndexOf(longest)));
}

function between(lower: number | undefined, upper: number | undefined): number {
  if (lower === undefined) return upper === undefined ? 0 : upper - 1;
  return upper === undefined ? Math.floor(lower) + 1 : (lower + upper) / 2;
}

const written = (key: number): number => Number(maskCoord(key));

/** Whether the six-decimal wire form keeps the planned order against itself and every verbatim key. */
function survivesFormatting(keys: readonly number[], verbatim: readonly number[]): boolean {
  const wire = keys.map(written);
  return (
    wire.every((key, index) => index === 0 || wire[index - 1] < key) &&
    keys.every((key, index) =>
      verbatim.every((v) => Math.sign(wire[index] - v) === Math.sign(key - v) && wire[index] !== v),
    )
  );
}

function spacedKey(
  low: number | undefined,
  high: number | undefined,
  j: number,
  c: number,
): number {
  if (low !== undefined && high !== undefined) return low + ((high - low) * (j + 1)) / (c + 1);
  if (high !== undefined) return high - c + j;
  return Math.floor(low ?? -1) + 1 + j;
}

/** Spread the keys sharing a gap between two verbatim keys evenly across that gap. */
function respaced(keys: readonly number[], verbatim: readonly number[]): number[] {
  const bounds = [...verbatim].sort((a, b) => a - b);
  const gaps = keys.map((key) => bounds.filter((v) => v < key).length);
  return gaps.map((gap, index) => {
    const members = gaps.flatMap((other, at) => (other === gap ? [at] : []));
    return spacedKey(bounds[gap - 1], bounds[gap], members.indexOf(index), members.length);
  });
}

/**
 * The key each modeled layer is written with. With no keyed verbatim
 * correction this is the plain model-index rule; otherwise kept layers keep
 * their read key and every other layer lands just above its model predecessor,
 * below the next kept layer or verbatim correction.
 */
export function planLayerOrder(
  layers: readonly LocalAdjustment[],
  verbatim: readonly number[],
): LayerOrderOf {
  if (verbatim.length === 0) return layerOrderOf(layers);
  const readKeys = layers.map((layer) => layer.xmpLayerOrder);
  const kept = keptIndices(readKeys);
  const assigned = readKeys.reduce<number[]>((keys, readKey, index) => {
    if (kept.has(index) && readKey !== undefined) return [...keys, readKey];
    const lower = index === 0 ? undefined : keys[index - 1];
    const later = readKeys.filter(
      (key, other): key is number => other > index && kept.has(other) && key !== undefined,
    );
    const above = verbatim.filter((key) => lower === undefined || key > lower);
    const bounds = [...later, ...above];
    return [...keys, between(lower, bounds.length ? Math.min(...bounds) : undefined)];
  }, []);
  const final = survivesFormatting(assigned, verbatim) ? assigned : respaced(assigned, verbatim);
  const positions = new Map(layers.map((layer, index) => [layer, final[index]] as const).reverse());
  return (layer) => positions.get(layer);
}
