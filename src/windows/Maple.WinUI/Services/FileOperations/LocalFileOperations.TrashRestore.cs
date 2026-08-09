// LocalFileOperations.TrashRestore.cs — restore out of `.maple/trash/<rel>`
// back to an asset's original location (#2654 UI; #2632 laid the trash-IN
// half only, with no restore counterpart). Windows has no OS-level way to
// restore FROM the Recycle Bin through this module — a Recycle Bin item
// restores through Explorer, never here (see LocalFileOperations.Trash.cs's
// header) — so this file exists purely for the `.maple/trash` fallback path
// (SMB, or any local-fixed-drive delete where the Recycle Bin call itself
// failed).
//
// Mirrors the API's `moveOutOfTrash` (`src/api/src/fs/trash.ts`): a
// destination that's already occupied gets a `.restored[.N]` suffix — the
// same intentionally different, human-legible naming `pickFreeRestoredPath`
// established server-side — rather than the generic `.N` CollisionResolver
// uses elsewhere in this module.
//
// #2743 review fix: the ORIGINAL relative path is no longer recovered by
// inverting `TrashPaths.TrashDestinationDir`'s path math alone. That
// inversion is exact for the common case, but `TrashToMapleFolderAsync`
// (LocalFileOperations.Trash.cs) auto-suffixes the trash-side BASENAME on a
// trash-side collision — two different photos trashed from the same
// original folder with the same name — and inverting that suffixed name
// silently returns the wrong original ("photo.1.jpg" as if that were the
// real name, permanently renaming the restored file). The true original
// relative path is instead RECORDED at trash time, in a plain `.origpath`
// marker file next to the trashed primary (`TryWriteOriginalPathMarker`,
// written by `Services/FileOperations/TrashSelectionLogic.cs`'s
// `ApplyOneAsync` — the caller that still has the pre-trash path in hand).
// Path-inversion survives only as the fallback for a trash item with no
// marker (e.g. one trashed before this fix shipped) — exact except across
// exactly the trash-side-collision case that motivated recording the
// marker in the first place.

using System;
using System.IO;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.FileOperations
{
    public static partial class LocalFileOperations
    {
        /// <summary>Restore <paramref name="trashPrimaryPath"/> (and its
        /// paired sidecar, if any — followed automatically by
        /// <see cref="RelocateAsync"/>, the same way every other relocate in
        /// this module follows a sidecar) from `.maple/trash/&lt;rel&gt;`
        /// back to its original location under <paramref name="libraryRoot"/>.
        /// The destination directory is created if the original folder no
        /// longer exists (e.g. the user deleted an otherwise-now-empty
        /// folder after trashing its last photo). The `.origpath` marker
        /// (see this file's header), if one was written at trash time, is
        /// deleted on a successful restore so trash doesn't accumulate
        /// orphaned markers. Throws <see cref="FileOperationException"/>
        /// (kind <see cref="FileOperationErrorKind.InvalidDestination"/>)
        /// without touching anything on disk if the recorded original path
        /// would resolve outside <paramref name="libraryRoot"/> — see
        /// <see cref="ResolveRestoreTargetPath"/>.</summary>
        public static async Task<RelocateOutcome> RestoreFromMapleTrashAsync(
            string trashPrimaryPath, string libraryRoot)
        {
            var relativePath = ComputeOriginalRelativePath(trashPrimaryPath, libraryRoot);
            var targetPath = ResolveRestoreTargetPath(relativePath, libraryRoot);
            var destinationDir = Path.GetDirectoryName(targetPath) ?? libraryRoot;
            var basename = Path.GetFileName(targetPath);

            var occupied = File.Exists(targetPath) || Directory.Exists(targetPath);
            var finalBasename = occupied ? PickFreeRestoredBasename(destinationDir, basename) : basename;

            // finalBasename is already guaranteed free (either it was free
            // to begin with, or PickFreeRestoredBasename found a free
            // `.restored[.N]` variant) — CollisionPolicy.Replace tells
            // RelocateAsync to use it as-is rather than re-running its own
            // (differently-named) auto-suffix logic on top of a name this
            // method already resolved.
            var outcome = await RelocateAsync(trashPrimaryPath, destinationDir, finalBasename,
                RelocateMode.Move, CollisionPolicy.Replace).ConfigureAwait(false);
            TryDelete(OriginalPathMarkerFor(trashPrimaryPath));
            return outcome;
        }

        /// <summary>Resolves <paramref name="relativePath"/> (from
        /// <see cref="ComputeOriginalRelativePath"/>) against
        /// <paramref name="libraryRoot"/> and REFUSES the result if it
        /// doesn't stay inside the root, rather than silently restoring
        /// somewhere else. Load-bearing, not defensive noise:
        /// <paramref name="relativePath"/> can come straight from a
        /// `.origpath` marker file's contents — data read off disk, and on
        /// the `.maple/trash` fallback (SMB shares in particular) that file
        /// sits on a share Maple doesn't otherwise control the contents of.
        /// <see cref="Path.Combine(string, string)"/> passes an absolute
        /// second argument through unchanged, and
        /// <see cref="Path.GetFullPath(string)"/> resolves `..` segments —
        /// together, an unvalidated marker turns this restore into an
        /// arbitrary-path file WRITE (#2743 review finding). On a
        /// violation, the trashed file and its marker are left exactly as
        /// they were: this throws before <see cref="RestoreFromMapleTrashAsync"/>
        /// creates any directory or even calls
        /// <see cref="File.Exists(string)"/> against the untrusted
        /// path.</summary>
        internal static string ResolveRestoreTargetPath(string relativePath, string libraryRoot)
        {
            var rootFull = TrashPaths.NormalizeDir(Path.GetFullPath(libraryRoot));
            var targetFull = Path.GetFullPath(Path.Combine(libraryRoot, relativePath));
            var isUnderRoot = targetFull.StartsWith(
                rootFull + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
            if (!isUnderRoot)
                throw new FileOperationException(FileOperationErrorKind.InvalidDestination,
                    $"recorded original path escapes the library root: {relativePath}");
            return targetFull;
        }

        /// <summary>Best-effort marker recording <paramref name="originalRelativePath"/>
        /// as the exact relative path (from the library root)
        /// <paramref name="trashPrimaryPath"/> originally occupied — written
        /// once, at trash time, by the caller that still has that
        /// information (see this file's header). Never fatal to the trash
        /// operation itself: worst case, <see cref="ComputeOriginalRelativePath"/>'s
        /// path-inversion fallback runs at restore time instead, exactly as
        /// it did before this marker existed.</summary>
        public static void TryWriteOriginalPathMarker(string trashPrimaryPath, string originalRelativePath)
        {
            try
            {
                File.WriteAllText(OriginalPathMarkerFor(trashPrimaryPath), originalRelativePath);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }

        /// <summary>The relative path (from the library root)
        /// <paramref name="trashItemPath"/> should restore to. Prefers the
        /// recorded `.origpath` marker — exact by construction, see this
        /// file's header — and falls back to inverting
        /// <see cref="TrashPaths.TrashDestinationDir"/>'s path math only
        /// when no marker exists.</summary>
        internal static string ComputeOriginalRelativePath(string trashItemPath, string libraryRoot)
        {
            var markerPath = OriginalPathMarkerFor(trashItemPath);
            try
            {
                if (File.Exists(markerPath))
                {
                    var recorded = File.ReadAllText(markerPath).Trim();
                    if (recorded.Length > 0) return recorded;
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }

            return InferOriginalRelativePath(trashItemPath, libraryRoot);
        }

        /// <summary>Inverts <see cref="TrashPaths.TrashDestinationDir"/>:
        /// given a path inside `&lt;libraryRoot&gt;/.maple/trash/…`, returns
        /// the relative path (directory + filename) it originally occupied
        /// under <paramref name="libraryRoot"/>. Exact EXCEPT across a
        /// trash-side basename collision, where the trash-side name itself
        /// carries a numeric suffix the original never had — see this
        /// file's header; <see cref="ComputeOriginalRelativePath"/> only
        /// falls back to this when no `.origpath` marker recorded the real
        /// answer.</summary>
        internal static string InferOriginalRelativePath(string trashItemPath, string libraryRoot)
        {
            var rootFull = TrashPaths.NormalizeDir(Path.GetFullPath(libraryRoot));
            var itemFull = Path.GetFullPath(trashItemPath);
            var trashRoot = TrashPaths.NormalizeDir(Path.Combine(rootFull, ".maple", "trash"));

            var isRoot = string.Equals(itemFull, trashRoot, StringComparison.OrdinalIgnoreCase);
            var isUnderRoot = itemFull.StartsWith(
                trashRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
            if (isRoot || !isUnderRoot)
                throw new FileOperationException(FileOperationErrorKind.InvalidDestination,
                    $"{trashItemPath} is not inside the Maple trash for {libraryRoot}");

            return itemFull[(trashRoot.Length + 1)..];
        }

        /// <summary>`&lt;trashPrimaryPath&gt;.origpath` — deterministic from
        /// the trash-side primary path alone, so a caller that only has the
        /// trash-side path (a restore, or a trash listing) never needs
        /// separate plumbing to find the marker.</summary>
        internal static string OriginalPathMarkerFor(string trashPrimaryPath) => trashPrimaryPath + ".origpath";

        /// <summary>`&lt;stem&gt;.restored&lt;ext&gt;`, then
        /// `&lt;stem&gt;.restored.N&lt;ext&gt;` — mirrors the API's
        /// `pickFreeRestoredPath` naming exactly, bounded the same way
        /// <see cref="CollisionResolver"/> bounds the generic `.N`
        /// scheme.</summary>
        internal static string PickFreeRestoredBasename(string destinationDir, string basename)
        {
            var ext = Path.GetExtension(basename);
            var stem = ext.Length > 0 ? basename[..^ext.Length] : basename;

            var first = $"{stem}.restored{ext}";
            if (!Occupied(destinationDir, first)) return first;

            for (var n = 1; n <= CollisionResolver.MaxAttempts; n++)
            {
                var candidate = $"{stem}.restored.{n}{ext}";
                if (!Occupied(destinationDir, candidate)) return candidate;
            }

            throw new FileOperationException(FileOperationErrorKind.Underlying,
                $"pickFreeRestoredBasename: exceeded {CollisionResolver.MaxAttempts} candidate paths for {basename}");
        }

        private static bool Occupied(string dir, string basename)
        {
            var candidate = Path.Combine(dir, basename);
            return File.Exists(candidate) || Directory.Exists(candidate);
        }
    }
}
