// RAW+JPEG stacks (#5050). The Self Hosted listing folds a same-stem JPEG into
// its RAW's entry: the RAW is the one tile and the primary, and the JPEG rides
// along as `stack.companion`. Every action that moves, renames or trashes the
// tile has to carry the companion too; export reads the RAW only.

import type { Asset, AssetId } from './asset';

/** The JPEG folded into a RAW's tile, as the Info pane lists it. */
export interface StackCompanion {
  readonly id: AssetId;
  readonly name: string;
  readonly ext: string;
  readonly size: number;
}

export interface AssetStack {
  readonly companion: StackCompanion;
}

/** Wire shape of `ImageEntry.stack` (see `docs/api.md` § RAW+JPEG stacks). */
export interface StackWire {
  readonly companion: {
    readonly name: string;
    readonly address: string;
    readonly size: number;
    readonly ext: string;
  };
}

export function stackFromWire(wire: StackWire | undefined): Partial<Pick<Asset, 'stack'>> {
  return wire
    ? {
        stack: {
          companion: {
            id: wire.companion.address,
            name: wire.companion.name,
            ext: wire.companion.ext,
            size: wire.companion.size,
          },
        },
      }
    : {};
}

/**
 * Wire shape of `SearchResult.stack` (#5849): the listing companion's fields plus the JPEG's
 * asset `id`, with `address` null when its library has no slug.
 */
export interface SearchStackWire {
  readonly companion: Omit<StackWire['companion'], 'address'> & {
    readonly id: string;
    readonly address: string | null;
    readonly path: string;
    readonly mtime: string;
  };
}

/** A timeline or search hit's stack, keyed by the companion's address as the listing's is. */
export function stackFromSearchWire(
  wire: SearchStackWire | undefined,
): Partial<Pick<Asset, 'stack'>> {
  const address = wire?.companion.address;
  return wire && address ? stackFromWire({ companion: { ...wire.companion, address } }) : {};
}

export function sameStack(a: Asset['stack'], b: Asset['stack']): boolean {
  return (
    a?.companion.id === b?.companion.id &&
    a?.companion.name === b?.companion.name &&
    a?.companion.size === b?.companion.size
  );
}

/** One file of a tile, as the move, rename and trash queues address it. */
export interface StackFile {
  readonly id: AssetId;
  readonly filename: string;
}

/** One tile as its file operations see it: a pair is one tile but two files,
 * so the queues carry the RAW with its JPEG and act on the JPEG only after
 * the RAW's outcome is known. */
export interface StackTile extends StackFile {
  readonly companion?: StackFile;
}

function stackTile({ id, filename, stack }: Pick<Asset, 'id' | 'filename' | 'stack'>): StackTile {
  return stack
    ? { id, filename, companion: { id: stack.companion.id, filename: stack.companion.name } }
    : { id, filename };
}

/** The tiles behind `ids`, in order. An unknown id stays a one-file tile named
 * by its id; an id that is already the companion of another selected tile is
 * dropped, so no file is queued twice. */
export function stackTiles(
  ids: readonly AssetId[],
  assets: readonly Pick<Asset, 'id' | 'filename' | 'stack'>[],
): StackTile[] {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const tiles = [...new Set(ids)].map((id) => {
    const asset = byId.get(id);
    return asset ? stackTile(asset) : { id, filename: id };
  });
  const companions = new Set(tiles.flatMap((tile) => (tile.companion ? [tile.companion.id] : [])));
  return tiles.filter((tile) => !companions.has(tile.id));
}
