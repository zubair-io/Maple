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

export function sameStack(a: Asset['stack'], b: Asset['stack']): boolean {
  return (
    a?.companion.id === b?.companion.id &&
    a?.companion.name === b?.companion.name &&
    a?.companion.size === b?.companion.size
  );
}

/** The `{ id, filename }` pair the move and trash queues carry per file. */
export interface StackMember {
  readonly id: AssetId;
  readonly filename: string;
}

/** Each asset followed by its companion, so an action on the tile covers both files. */
export function withStackCompanions(
  assets: readonly Pick<Asset, 'id' | 'filename' | 'stack'>[],
): StackMember[] {
  return assets.flatMap(({ id, filename, stack }) => [
    { id, filename },
    ...(stack ? [{ id: stack.companion.id, filename: stack.companion.name }] : []),
  ]);
}

/** Asset ids with each stacked asset's companion id appended; duplicates collapse. */
export function idsWithCompanions(
  ids: readonly AssetId[],
  assets: readonly Pick<Asset, 'id' | 'stack'>[],
): AssetId[] {
  const stackOf = new Map(assets.map((a) => [a.id, a.stack]));
  return [
    ...new Set(
      ids.flatMap((id) => {
        const companion = stackOf.get(id)?.companion;
        return companion ? [id, companion.id] : [id];
      }),
    ),
  ];
}

function stemOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** The companion's name after its RAW is renamed: the RAW's new stem, the companion's own extension. */
export function companionFilenameFor(companionName: string, rawNewFilename: string): string {
  const dot = companionName.lastIndexOf('.');
  const ext = dot > 0 ? companionName.slice(dot) : '';
  return `${stemOf(rawNewFilename)}${ext}`;
}
