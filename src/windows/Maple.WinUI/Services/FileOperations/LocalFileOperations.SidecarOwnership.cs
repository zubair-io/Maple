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
        /// aliased folder still maps <c>X.xmp</c> onto itself. Names that
        /// differ only in case are one file only where the folder folds case
        /// (a case-sensitive NTFS directory keeps <c>x.xmp</c> and
        /// <c>X.xmp</c> apart). A path that cannot be resolved counts as the
        /// same file: the sidecar is then kept, never deleted.</summary>
        internal static bool SameSidecarPath(string a, string b)
        {
            try
            {
                var (hopsA, hopsB) = (0, 0);
                var (resolvedA, resolvedB) = (FullyResolvedPath(a, ref hopsA), FullyResolvedPath(b, ref hopsB));
                if (string.Equals(resolvedA, resolvedB, StringComparison.Ordinal)) return true;
                return string.Equals(resolvedA, resolvedB, StringComparison.OrdinalIgnoreCase)
                    && FolderFoldsCaseBetween(resolvedA, resolvedB);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return true;
            }
        }

        /// <summary>For two paths differing only in case: a case-folding folder
        /// finds the second name through the first entry, while a
        /// case-sensitive one either lacks it or lists both names
        /// separately.</summary>
        private static bool FolderFoldsCaseBetween(string a, string b)
        {
            var dir = Path.GetDirectoryName(a);
            if (dir == null || !File.Exists(a) || !File.Exists(b)) return false;
            var names = Directory.EnumerateFileSystemEntries(dir).Select(Path.GetFileName).ToHashSet(StringComparer.Ordinal);
            return !(names.Contains(Path.GetFileName(a)) && names.Contains(Path.GetFileName(b)));
        }

        // The same bound POSIX puts on one lookup (SYMLOOP_MAX): links that
        // loop through each other across several segments would otherwise
        // recurse until the stack overflows, which no catch can stop.
        private const int MaxLinkHops = 40;

        private static string FullyResolvedPath(string path, ref int hops)
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
                if (target == null) continue;
                if (++hops > MaxLinkHops) throw new IOException($"Too many directory links resolving {path}.");
                current = FullyResolvedPath(target.FullName, ref hops);
            }
            return current;
        }

        // Generated staging names (`<name>.tmp.<pid>-<guid>`); a real photo
        // whose name merely contains `.tmp.` still claims its stem.
        private static readonly Regex StagingName =
            new(@"\.tmp\.\d+[-.][0-9a-fA-F]+$", RegexOptions.CultureInvariant);

        // Photo formats any Maple surface pairs with a sidecar — wider than
        // what Windows itself opens, because an IMG_1.HEIC beside IMG_1.CR3
        // still reads IMG_1.xmp on Apple and Web. Non-media files (notes.txt,
        // IMG_1.txt) never claim a stem.
        private static readonly System.Collections.Generic.HashSet<string> PhotoExtensions =
            new(DropMountLogic.SupportedExtensions.Concat(new[]
            {
                ".heic", ".heif", ".png", ".webp", ".avif", ".psd", ".psb", ".gif", ".bmp", ".jxl",
                ".crw", ".nrw", ".sr2", ".srf", ".erf", ".kdc", ".dcr", ".mrw", ".mos", ".iiq",
                ".3fr", ".fff", ".rwl", ".x3f", ".raw",
            }), StringComparer.OrdinalIgnoreCase);

        private static bool IsMediaFile(string name) =>
            SidecarStore.IsVideoFilename(name) || PhotoExtensions.Contains(Path.GetExtension(name));

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
                var names = Directory.EnumerateFiles(dir).Select(Path.GetFileName).ToHashSet(StringComparer.Ordinal);
                return names.Any(name =>
                    !name!.StartsWith('.')
                    && !StagingName.IsMatch(name)
                    && IsMediaFile(name)
                    && !skip.Contains(Path.Combine(dir, name), StringComparer.OrdinalIgnoreCase)
                    && SiblingReadsSameSidecar(dir, name, stem, names!));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return true;
            }
        }

        /// <summary>A sibling whose stem differs only in case reads the same
        /// sidecar only where the folder folds case: its name re-cased to
        /// <paramref name="stem"/> then reaches it without being listed as a
        /// file of its own.</summary>
        private static bool SiblingReadsSameSidecar(
            string dir, string siblingName, string stem, System.Collections.Generic.ISet<string> names)
        {
            var siblingStem = SidecarStemOf(siblingName);
            if (string.Equals(siblingStem, stem, StringComparison.Ordinal)) return true;
            if (!string.Equals(siblingStem, stem, StringComparison.OrdinalIgnoreCase)) return false;
            var recased = SidecarStore.IsVideoFilename(siblingName) ? stem : stem + Path.GetExtension(siblingName);
            return !names.Contains(recased) && File.Exists(Path.Combine(dir, recased));
        }

        /// <summary>True when <paramref name="destination"/> already holds
        /// exactly <paramref name="source"/>'s bytes — the sidecar an earlier
        /// same-stem photo carried there (both halves of a RAW+JPEG pair moved
        /// one after the other). Joining it neither overwrites nor adopts
        /// different edits, so it is not a collision. A file past the
        /// sidecar editing limit is no sidecar Maple wrote, and is never read
        /// whole to find out.</summary>
        internal static bool SidecarAlreadyCarried(string source, string destination)
        {
            try
            {
                var (sourceInfo, destinationInfo) = (new FileInfo(source), new FileInfo(destination));
                return sourceInfo.Exists && destinationInfo.Exists
                    && sourceInfo.Length == destinationInfo.Length
                    && sourceInfo.Length <= SidecarStore.MaxSidecarBytes
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
