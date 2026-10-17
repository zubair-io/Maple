// LocalFileOperations.SidecarOwnership.cs — the shared-sidecar ownership rule
// (#4758, docs/xmp-canonical-format.md § "Moving, renaming and trashing a
// photo"; the API twin is `src/api/src/fs/sidecar-ownership.ts`). Images swap
// the extension for `.xmp`, so `IMG_1.CR3` and `IMG_1.JPG` share `IMG_1.xmp`:
// a relocate copies a sidecar a sibling still uses instead of taking it,
// treats an occupied destination sidecar as a collision for the whole asset,
// and leaves a sidecar that maps onto itself alone.

using System;
using System.IO;
using System.Linq;
using System.Text;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.FileOperations
{
    public static partial class LocalFileOperations
    {
        internal static bool SameSidecarPath(string a, string b) =>
            string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);

        private static string SidecarStemOf(string fileName) =>
            (SidecarStore.IsVideoFilename(fileName) ? fileName : Path.GetFileNameWithoutExtension(fileName))
                .Normalize(NormalizationForm.FormC);

        /// <summary>True when a file in <paramref name="primaryPath"/>'s
        /// folder, other than the primary and <paramref name="excluded"/>,
        /// reads the same sidecar. Over-inclusive on purpose: a false positive
        /// leaves a harmless duplicate sidecar, a false negative carries away
        /// another photo's edits.</summary>
        internal static bool SidecarStemClaimedBySibling(string primaryPath, params string[] excluded)
        {
            var dir = Path.GetDirectoryName(Path.GetFullPath(primaryPath));
            if (dir == null || !Directory.Exists(dir)) return false;
            var skip = excluded.Append(primaryPath).Select(Path.GetFullPath).ToArray();
            var stem = SidecarStemOf(Path.GetFileName(primaryPath));
            try
            {
                return Directory.EnumerateFiles(dir).Any(path =>
                {
                    var name = Path.GetFileName(path);
                    return !name.StartsWith('.')
                        && !name.Contains(".tmp.", StringComparison.Ordinal)
                        && !string.Equals(Path.GetExtension(name), ".xmp", StringComparison.OrdinalIgnoreCase)
                        && !skip.Contains(path, StringComparer.OrdinalIgnoreCase)
                        && string.Equals(SidecarStemOf(name), stem, StringComparison.OrdinalIgnoreCase);
                });
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return true;
            }
        }

        /// <summary>True when <paramref name="destination"/> already holds
        /// exactly <paramref name="source"/>'s bytes — the sidecar an earlier
        /// same-stem photo carried there (both halves of a RAW+JPEG pair moved
        /// one after the other). Joining it neither overwrites nor adopts
        /// different edits, so it is not a collision.</summary>
        internal static bool SidecarAlreadyCarried(string source, string destination)
        {
            try
            {
                return File.Exists(source) && File.Exists(destination)
                    && File.ReadAllBytes(source).AsSpan().SequenceEqual(File.ReadAllBytes(destination));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return false;
            }
        }

        /// <summary>The whole asset collides at <paramref name="candidate"/>
        /// when the photo name is taken or its sidecar name is held by any
        /// file other than the moving asset's own sidecar or an identical
        /// copy of it.</summary>
        internal static bool AssetDestinationOccupied(string candidate, string ownSidecarPath)
        {
            if (PathOccupied(candidate)) return true;
            var sidecar = SidecarStore.SidecarPathFor(candidate);
            return PathOccupied(sidecar)
                && !SameSidecarPath(sidecar, ownSidecarPath)
                && !SidecarAlreadyCarried(ownSidecarPath, sidecar);
        }
    }
}
