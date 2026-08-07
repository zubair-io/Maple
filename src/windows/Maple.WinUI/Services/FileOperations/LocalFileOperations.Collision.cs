// LocalFileOperations.Collision.cs — collision resolution for the relocate
// primitive (issue #2632). A pure computation for `.Fail`/`.AutoSuffix`;
// `.Replace` performs the actual removal as a side effect (it has to happen
// here, before the copy that follows, rather than being deferred to the
// caller).

using System.IO;
using System.Threading.Tasks;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.FileOperations
{
    public static partial class LocalFileOperations
    {
        /// <summary>Resolve a collision at <paramref name="targetPath"/> per
        /// <paramref name="collision"/>, returning the (possibly suffixed)
        /// final path and whether a suffix was applied.</summary>
        private static async Task<(string Path, bool Renamed)> ResolveCollisionAsync(
            string targetPath, CollisionPolicy collision)
        {
            if (!File.Exists(targetPath)) return (targetPath, false);

            switch (collision)
            {
                case CollisionPolicy.Fail:
                    throw new FileOperationException(FileOperationErrorKind.DestinationExists, targetPath);
                case CollisionPolicy.Replace:
                    RemoveAssetAndSidecar(targetPath);
                    return (targetPath, false);
                case CollisionPolicy.AutoSuffix:
                    var free = await CollisionResolver
                        .PickFreePathAsync(targetPath, p => Task.FromResult(File.Exists(p)))
                        .ConfigureAwait(false);
                    return (free, true);
                default:
                    throw new System.ArgumentOutOfRangeException(nameof(collision));
            }
        }

        /// <summary>Remove <paramref name="path"/> and its sidecar (if any),
        /// best-effort on the sidecar (a lost sidecar copy is recoverable;
        /// the RAW move is authoritative) but NOT on the primary — a
        /// `.Replace` collision must genuinely clear the primary before the
        /// copy that follows, so a real removal failure there
        /// propagates.</summary>
        internal static void RemoveAssetAndSidecar(string path)
        {
            File.Delete(path);
            var sidecarPath = SidecarStore.SidecarPathFor(path);
            TryDelete(sidecarPath);
        }
    }
}
