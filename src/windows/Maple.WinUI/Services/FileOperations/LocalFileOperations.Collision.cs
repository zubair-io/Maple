// LocalFileOperations.Collision.cs — collision resolution for the relocate
// primitive (issue #2632). A pure computation for every policy, including
// `.Replace`: this deliberately does NOT pre-delete the occupant. An earlier
// version called a delete here before the copy that follows — the
// "delete-then-hope" shape that, if the copy then failed (disk full, a
// transient IO error, an AV lock), left NEITHER the old nor the new file on
// disk, violating this module's own "a duplicate is left on disk, never data
// loss" contract. `CopyVerified` already publishes via a temp-file-then-
// `File.Move(..., overwrite: true)`, which replaces an existing occupant
// ATOMICALLY at the very end, after the copy is fully verified — so
// `.Replace` needs no removal step of its own at all; it only needs to
// resolve to the occupied path unchanged and let the verified publish do the
// replacing.
//
// A directory sitting at the target is never a valid occupant for ANY
// policy — `File.Exists` alone doesn't see it, so every existence check here
// checks `Directory.Exists` too.

using System.IO;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.FileOperations
{
    public static partial class LocalFileOperations
    {
        private static bool PathOccupied(string path) => File.Exists(path) || Directory.Exists(path);

        /// <summary>Resolve a collision at <paramref name="targetPath"/> per
        /// <paramref name="collision"/>, returning the (possibly suffixed)
        /// final path and whether a suffix was applied.</summary>
        private static async Task<(string Path, bool Renamed)> ResolveCollisionAsync(
            string targetPath, CollisionPolicy collision)
        {
            if (!PathOccupied(targetPath)) return (targetPath, false);

            switch (collision)
            {
                case CollisionPolicy.Fail:
                    throw new FileOperationException(FileOperationErrorKind.DestinationExists, targetPath);
                case CollisionPolicy.Replace:
                    if (Directory.Exists(targetPath))
                        throw new FileOperationException(FileOperationErrorKind.InvalidDestination,
                            $"cannot replace a folder with a file: {targetPath}");
                    // No removal here — see the file header. The occupant
                    // stays on disk, untouched, until `CopyVerified`'s
                    // atomic publish replaces it in one step.
                    return (targetPath, false);
                case CollisionPolicy.AutoSuffix:
                    var free = await CollisionResolver
                        .PickFreePathAsync(targetPath, p => Task.FromResult(PathOccupied(p)))
                        .ConfigureAwait(false);
                    return (free, true);
                default:
                    throw new System.ArgumentOutOfRangeException(nameof(collision));
            }
        }
    }
}
