// DropMountLogic.cs — pure decision logic behind dropping OS files/folders
// onto the app window to mount-by-reference (#2651), the Windows sibling of
// Apple's drop-to-mount. WinUI-free by construction, like
// FolderTreeCrudLogic.cs (see that file's header): plain System.IO, no
// WinUI/WinRT types. Links into Maple.WinUI.Tests via this directory's
// existing wildcard Compile Include.
//
// The actual OS drag/drop mechanics (AllowDrop, DataPackageView,
// GetStorageItemsAsync) live in MainWindow.DropMount.cs; the actual
// mount/navigate calls (AddLibraryFolder, LoadDirectory, SetMode,
// selection) live in EditSessionViewModel.DropMount.cs and
// MainWindow.DropMount.cs. Neither belongs here — this file only decides
// WHICH of the four cases a drop is and what folder/files that implies.
//
// The four cases from the ticket collapse into two independent axes this
// class computes separately, rather than four hand-written branches that
// could drift out of sync with each other:
//   - Kind (OpenFile vs Browse) depends only on whether exactly one
//     supported FILE was dropped (a lone folder, or two-or-more items of
//     any kind, browse instead of opening Full Image directly).
//   - AlreadyMounted (skip the mount, navigate/select only) depends only on
//     whether every accepted item already sits under a registered library
//     root (FolderTreeCrudLogic.FindLibraryRoot) — independent of Kind.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Maple.WinUI.Services.FileOperations
{
    public enum DropOutcomeKind
    {
        /// <summary>Exactly one supported photo file was dropped — open it
        /// directly in Full Image (Preview) rather than landing in Browse.</summary>
        OpenFile,

        /// <summary>A folder, or two-or-more items, were dropped — land in
        /// Browse at <see cref="DropMountPlan.NavigateFolder"/>, with
        /// <see cref="DropMountPlan.SelectFiles"/> selected in the grid
        /// (empty when the drop was folder(s) only).</summary>
        Browse,

        /// <summary>Nothing in the drop was usable — an unsupported file
        /// type, or every path already vanished from disk before the drop
        /// landed. <see cref="DropMountPlan.UnsupportedReason"/> explains
        /// why; no mount, no navigation.</summary>
        Unsupported,
    }

    /// <summary>The resolved plan for one OS drop. <see cref="MountRoot"/>
    /// is non-null only when a NEW library root needs registering
    /// (AddLibraryFolder); when <see cref="AlreadyMounted"/> is true the
    /// caller navigates/selects without mounting anything, satisfying the
    /// ticket's fourth case regardless of whether the drop would otherwise
    /// have been a single file, a folder, or multiple files.</summary>
    public sealed record DropMountPlan(
        DropOutcomeKind Kind,
        bool AlreadyMounted,
        string? MountRoot,
        string NavigateFolder,
        IReadOnlyList<string> SelectFiles,
        string? UnsupportedReason);

    public static class DropMountLogic
    {
        // Mirrors EditSessionViewModel.Library.cs's SupportedExtensions.
        // Kept as its own copy here rather than a shared reference: that
        // file carries the WinUI-dependent bulk of EditSessionViewModel
        // (CommunityToolkit.Mvvm-generated members, ObservableCollection
        // wiring) and per Maple.WinUI.Tests.csproj's header comment isn't
        // linkable into this WinUI-free test project the way PhotoItem
        // isn't either. If the supported-format list changes, update both.
        public static readonly IReadOnlyCollection<string> SupportedExtensions = new[]
        {
            ".dng", ".arw", ".cr3", ".cr2", ".nef", ".orf", ".rw2", ".pef", ".raf", ".srw",
            ".tif", ".tiff", ".jpg", ".jpeg",
        };

        /// <summary>Resolves what an OS drop of <paramref
        /// name="droppedPaths"/> onto the app window should do, given the
        /// currently registered <paramref name="libraryRoots"/>. Performs
        /// real filesystem checks (Directory.Exists/File.Exists) — a path
        /// that vanished between the drag starting and the drop landing is
        /// treated the same as an unsupported type, not a crash.</summary>
        public static DropMountPlan Classify(
            IReadOnlyList<string> droppedPaths, IReadOnlyList<string> libraryRoots)
        {
            var distinct = droppedPaths
                .Where(p => !string.IsNullOrWhiteSpace(p))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();

            var accepted = new List<(string Path, bool IsDirectory)>();
            var rejected = new List<string>();
            foreach (var path in distinct)
            {
                if (Directory.Exists(path))
                {
                    accepted.Add((path, true));
                    continue;
                }
                if (File.Exists(path) && SupportedExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase))
                {
                    accepted.Add((path, false));
                    continue;
                }
                rejected.Add(path);
            }

            if (accepted.Count == 0)
                return new DropMountPlan(
                    DropOutcomeKind.Unsupported,
                    AlreadyMounted: false,
                    MountRoot: null,
                    NavigateFolder: string.Empty,
                    SelectFiles: Array.Empty<string>(),
                    UnsupportedReason: BuildUnsupportedReason(rejected));

            var containingCandidates = accepted
                .Select(a => a.IsDirectory ? a.Path : (Path.GetDirectoryName(a.Path) ?? a.Path))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            var navigateFolder = CommonAncestor(containingCandidates);

            var files = accepted.Where(a => !a.IsDirectory).Select(a => a.Path).ToList();
            var isSingleFile = accepted.Count == 1 && !accepted[0].IsDirectory;
            var kind = isSingleFile ? DropOutcomeKind.OpenFile : DropOutcomeKind.Browse;

            var alreadyMounted = accepted.All(
                a => FolderTreeCrudLogic.FindLibraryRoot(libraryRoots, a.Path) != null);

            return new DropMountPlan(
                kind,
                alreadyMounted,
                MountRoot: alreadyMounted ? null : navigateFolder,
                NavigateFolder: navigateFolder,
                SelectFiles: files,
                UnsupportedReason: null);
        }

        /// <summary>Walks a starting candidate up its own ancestor chain
        /// until it's an ancestor-of-or-equal-to every other path — simpler
        /// and more robust against drive-letter edge cases than splitting
        /// and rejoining path segments, and reuses the same
        /// case-insensitive containment check FolderTreeCrudLogic already
        /// established (IsSameOrDescendant).</summary>
        private static string CommonAncestor(IReadOnlyList<string> paths)
        {
            var candidate = TrashPaths.NormalizeDir(Path.GetFullPath(paths[0]));
            foreach (var path in paths.Skip(1))
            {
                var full = TrashPaths.NormalizeDir(Path.GetFullPath(path));
                while (!FolderTreeCrudLogic.IsSameOrDescendant(candidate, full))
                {
                    var parent = Path.GetDirectoryName(candidate);
                    if (string.IsNullOrEmpty(parent)
                        || string.Equals(parent, candidate, StringComparison.OrdinalIgnoreCase))
                        break; // hit a drive root with nothing higher to climb
                    candidate = parent;
                }
            }
            return candidate;
        }

        private static string BuildUnsupportedReason(IReadOnlyList<string> rejected)
        {
            if (rejected.Count == 0)
                return "Nothing usable was dropped.";
            if (rejected.Count == 1)
                return $"\"{Path.GetFileName(rejected[0])}\" isn't a photo format Maple supports "
                    + "(RAW, TIFF, or JPEG) — or it no longer exists at that location. Nothing was added.";
            return $"None of the {rejected.Count} dropped items are photo formats Maple supports "
                + "(RAW, TIFF, or JPEG) — or they no longer exist at that location. Nothing was added.";
        }
    }
}
