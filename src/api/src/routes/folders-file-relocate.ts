/** Raw-sidecar file moves use the same authorized paths for locking and I/O. */
import * as path from 'node:path';
import { relocateFile, type CollisionPolicy, type RelocateMode } from '../fs/relocate.ts';
import { serializeSidecarWrites } from '../fs/sidecar-write-order.ts';
import { authorizeSidecarWrite } from '../fs/sidecar-io.ts';
import { resolveRealPathThroughAncestors } from '../fs/root.ts';
import { mkdir } from '../fs/mirrored.ts';

export async function relocateRequestedFile(args: {
  libraryRoot: string;
  sourceAbsPath: string;
  destAbsPath: string;
  mode: RelocateMode;
  collision: CollisionPolicy;
  rawSidecar: boolean;
}): Promise<{ outcome: Awaited<ReturnType<typeof relocateFile>> } | { refused: string }> {
  const relocate = (source: string, destination: string) =>
    relocateFile({
      sourceAbsPath: source,
      destAbsPath: destination,
      mode: args.mode,
      collision: args.collision,
      callerTag: 'folders/file/relocate',
      carrySidecars: !args.rawSidecar,
    });
  if (!args.rawSidecar) return { outcome: await relocate(args.sourceAbsPath, args.destAbsPath) };
  const from = await authorizeSidecarWrite(args.sourceAbsPath);
  if (!from.ok) return { refused: from.error ?? 'source sidecar not allowed' };
  // Authorization resolves missing ancestors too, before creating any directory.
  const to = await authorizeSidecarWrite(args.destAbsPath);
  if (!to.ok) return { refused: to.error ?? 'destination sidecar not allowed' };
  const source = from.data!;
  const destination = to.data!;
  await mkdir(path.dirname(destination), { recursive: true });
  const root = await resolveRealPathThroughAncestors(args.libraryRoot);
  const outcome = await serializeSidecarWrites([source, destination], () =>
    relocate(source, destination),
  );
  // API addresses use the registered root's spelling (/var vs /private/var on
  // macOS), while the relative path names the actual authorized destination.
  return {
    outcome:
      outcome.kind === 'relocated'
        ? {
            ...outcome,
            newAbsPath: path.join(args.libraryRoot, path.relative(root, outcome.newAbsPath)),
          }
        : outcome,
  };
}
