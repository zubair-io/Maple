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
using System.Text.RegularExpressions;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI.Services.FileOperations
{
    public static partial class LocalFileOperations
    {
        /// <summary>Rule 3 asks whether two names are one sidecar file. Both
        /// paths are resolved through every directory link and junction on
        /// the way (not only the immediate parent), so a rename through an
        /// aliased folder still maps <c>X.xmp</c> onto itself. A path that
        /// cannot be resolved counts as the same file: the sidecar is then
        /// kept, never deleted.</summary>
        internal static bool SameSidecarPath(string a, string b)
        {
            try
            {
                return string.Equals(FullyResolvedPath(a), FullyResolvedPath(b), StringComparison.OrdinalIgnoreCase);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return true;
            }
        }

        private static string FullyResolvedPath(string path)
        {
            var full = Path.GetFullPath(path);
            var root = Path.GetPathRoot(full) ?? string.Empty;
            var current = root;
            foreach (var segment in full[root.Length..].Split(
                         new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar },
                         StringSplitOptions.RemoveEmptyEntries))
            {
                current = Path.Combine(current, segment);
                FileSystemInfo? link = Directory.Exists(current) ? new DirectoryInfo(current)
                    : File.Exists(current) ? new FileInfo(current)
                    : null;
                var target = link?.LinkTarget != null ? link.ResolveLinkTarget(returnFinalTarget: true) : null;
                if (target != null) current = FullyResolvedPath(target.FullName);
            }
            return current;
        }

        // Generated staging names (`<name>.tmp.<pid>-<guid>`); a real photo
        // whose name merely contains `.tmp.` still claims its stem.
        private static readonly Regex StagingName =
            new(@"\.tmp\.\d+[-.][0-9a-fA-F]+$", RegexOptions.CultureInvariant);

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
                        && !StagingName.IsMatch(name)
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
