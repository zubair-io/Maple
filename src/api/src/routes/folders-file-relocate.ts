/** Raw-sidecar file moves use the same authorized paths for locking and I/O. */
import * as path from 'node:path';
import { relocateFile, type CollisionPolicy, type RelocateMode } from '../fs/relocate.ts';
import { serializeSidecarWrites } from '../fs/sidecar-write-order.ts';
import { authorizeSidecarWrite } from '../fs/sidecar-io.ts';
import { safeWriteAllowed, resolveRealPathThroughAncestors } from '../fs/root.ts';
import { mkdir, withMirrorRoot } from '../fs/mirrored.ts';

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
  const destinationIsSidecar = path.extname(args.destAbsPath).toLowerCase() === '.xmp';
  const to = await (destinationIsSidecar ? authorizeSidecarWrite : safeWriteAllowed)(
    args.destAbsPath,
  );
  if (!to.ok) return { refused: to.error ?? 'destination sidecar not allowed' };
  // Resolve parents to pin folder aliases, but keep each requested leaf:
  // following a leaf symlink for I/O would move/delete its target instead.
  const source = path.join(
    await resolveRealPathThroughAncestors(path.dirname(args.sourceAbsPath)),
    path.basename(args.sourceAbsPath),
  );
  const requestedParent = await resolveRealPathThroughAncestors(path.dirname(args.destAbsPath));
  const requestedDestination = path.join(requestedParent, path.basename(args.destAbsPath));
  const destination = requestedDestination;
  const root = await resolveRealPathThroughAncestors(args.libraryRoot);
  const outcome = await withMirrorRoot(root, args.libraryRoot, async () => {
    await mkdir(path.dirname(destination), { recursive: true });
    return serializeSidecarWrites(
      destinationIsSidecar ? [source, from.data!, destination, to.data!] : [source, from.data!],
      () => relocate(source, destination),
    );
  });
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
