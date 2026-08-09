// EditSessionViewModel.DropMount.cs — the awaitable mount/navigate entry
// points behind dropping OS files/folders onto the app window (#2651).
// Split out of EditSessionViewModel.Library.cs to stay under this
// codebase's ~600-line file budget (that file's own header notes a prior
// split for the same reason, #2639).
//
// DropMountLogic.cs (Services/FileOperations/, WinUI-free) decides WHICH of
// the four cases a drop is; MainWindow.DropMount.cs owns the OS drag/drop
// mechanics and calls into this file to actually mount/navigate; this file
// is the seam between them — real ViewModel state (AllPhotos, LibraryFolders,
// FolderTree), but still no WinUI/WinRT types of its own.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        /// <summary>Awaitable wrapper over <see cref="AddLibraryFolder"/> —
        /// the fire-and-forget overload is enough for the folder-picker
        /// call site (MainWindow.Dialogs.cs), which never needs to act on
        /// the loaded photos afterward. A drop that wants to open a
        /// specific dropped file in Full Image, or select specific dropped
        /// files in Browse, needs to know when the initial load has
        /// actually landed in <see cref="Photos"/> first — same
        /// TaskCompletionSource-over-a-callback shape as
        /// EditSessionViewModel.FolderCrud.cs's RefreshFolderChildrenAsync.</summary>
        public Task AddLibraryFolderAsync(string folderPath)
        {
            // RunContinuationsAsynchronously (#2754): onReady fires from a
            // background-thread try/catch in some
            // LoadDirectory paths, not only from the dispatcher — without
            // this, a synchronous TrySetResult there would run the
            // awaiter's continuation (the rest of MainWindow.DropMount.cs's
            // async method) on that same background thread instead of
            // hopping back to the UI thread the caller expects.
            var tcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            AddLibraryFolder(folderPath, () => tcs.TrySetResult());
            return tcs.Task;
        }

        /// <summary>Awaitable wrapper over <see cref="LoadDirectory"/> — see
        /// <see cref="AddLibraryFolderAsync"/>'s doc comment. Used for the
        /// #2651 "already mounted, navigate only" case, where no new root
        /// needs registering.</summary>
        public Task LoadDirectoryAsync(string folderPath)
        {
            var tcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            LoadDirectory(folderPath, () => tcs.TrySetResult());
            return tcs.Task;
        }

        /// <summary>The <see cref="FolderNode"/> RebuildFolderTree
        /// (EditSessionViewModel.Library.cs) builds for a registered root
        /// that isn't reachable on disk right now — see
        /// FolderNode.IsUnavailable's doc comment for why this exists
        /// instead of either an error dialog or silently dropping the root
        /// from the sidebar.</summary>
        private static FolderNode BuildUnavailableFolderNode(string path)
        {
            var name = Path.GetFileName(path.TrimEnd(Path.DirectorySeparatorChar));
            return new FolderNode
            {
                Name = name.Length > 0 ? name : path,
                Path = path,
                IsUnavailable = true,
            };
        }

        /// <summary>Resolves the <see cref="PhotoItem"/>s already loaded
        /// into <see cref="AllPhotos"/> matching <paramref
        /// name="filePaths"/>, preserving drop order. Called after
        /// awaiting <see cref="AddLibraryFolderAsync"/>/<see
        /// cref="LoadDirectoryAsync"/>, once the dropped files' folder has
        /// actually been scanned. A path that doesn't resolve (raced away
        /// between the drop and the scan, or filtered out by a mismatch
        /// between DropMountLogic's and this app's supported-extension
        /// list) is silently skipped rather than throwing — the caller
        /// ends up selecting/opening whatever DID resolve, which degrades
        /// gracefully to "nothing selected" in the pathological all-skipped
        /// case rather than crashing the drop.</summary>
        public IReadOnlyList<PhotoItem> ResolveDroppedPhotos(IReadOnlyList<string> filePaths) =>
            filePaths
                .Select(fp => AllPhotos.FirstOrDefault(
                    p => string.Equals(p.FilePath, fp, StringComparison.OrdinalIgnoreCase)))
                .Where(p => p != null)
                .Select(p => p!)
                .ToList();
    }
}
