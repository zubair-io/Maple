// MainWindow.DropMount.cs — OS file/folder drops onto the app window,
// mounting by reference exactly as the Apple app does (#2651). This is the
// window-level counterpart to MainWindow.DragDrop.cs's internal PhotoGrid
// -> sources-tree drag: that file's OnFolderDragOver/OnFolderDrop
// deliberately leave AcceptedOperation untouched (and never set e.Handled)
// for any drag that isn't its own internal marker, precisely so an external
// OS drag — Explorer dragging files/folders in — bubbles past the FOLDERS
// tree rows and reaches these handlers on the window root instead, wired up
// in WireDropTarget (called from the MainWindow constructor,
// MainWindow.xaml.cs).
//
// All decision logic — which of the four cases a drop is, the common-parent
// computation for multiple loose files, "already inside a mounted source"
// detection — lives in the WinUI-free Services/FileOperations/
// DropMountLogic.cs, unit-tested with real temp dirs. The awaitable
// mount/navigate calls live in EditSessionViewModel.DropMount.cs. This file
// is UI-thread mechanics only: AllowDrop wiring, pulling file paths out of
// the DataPackageView, and turning a resolved DropMountPlan into the actual
// SetMode/selection calls — the same split every other file-operations
// feature in this app (MainWindow.Trash.cs, MainWindow.DragDrop.cs) uses.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Windows.ApplicationModel.DataTransfer;
using Windows.Storage;
using Maple.WinUI.Services;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        // Guards RunDropMountAsync against a re-entrant second drop — a
        // rapid second drop landing while the first is still mounting/
        // loading, or while the "can't open that" dialog from an
        // unsupported drop is still open — the same hazard shape
        // MainWindow.Trash.cs's _deleteGate exists for (WinUI allows only
        // one ContentDialog at a time, and this flow can show one).
        private readonly SingleFlightGate _dropGate = new();

        private void WireDropTarget(FrameworkElement root)
        {
            root.AllowDrop = true;
            root.DragOver += OnWindowDragOver;
            root.Drop += OnWindowDrop;
        }

        private void OnWindowDragOver(object sender, DragEventArgs e)
        {
            // Only react to a real OS file/folder drag (Explorer, another
            // app). PhotoGrid's own internal drag (MainWindow.DragDrop.cs)
            // carries text + a private marker, never StorageItems, so it
            // never matches here even if it bubbles this far.
            if (!e.DataView.Contains(StandardDataFormats.StorageItems))
                return;

            e.Handled = true;
            // Link, not Copy/Move: the drop mounts the folder BY REFERENCE
            // (CLAUDE.md's non-destructive-only invariant) — nothing is
            // copied or relocated, so neither of those operations describes
            // what actually happens.
            e.AcceptedOperation = DataPackageOperation.Link;
            e.DragUIOverride.IsCaptionVisible = true;
            e.DragUIOverride.Caption = "Open in Maple";
            e.DragUIOverride.IsGlyphVisible = true;
        }

        private async void OnWindowDrop(object sender, DragEventArgs e)
        {
            if (!e.DataView.Contains(StandardDataFormats.StorageItems))
                return;

            // GetStorageItemsAsync is genuinely async, so the drop's data
            // view needs a deferral to stay valid until it resolves — the
            // documented pattern for reading DataPackageView contents
            // inside a Drop handler.
            var deferral = e.GetDeferral();
            try
            {
                e.Handled = true;
                if (!_dropGate.TryEnter())
                    return;
                try
                {
                    await RunDropMountAsync(e.DataView);
                }
                finally
                {
                    _dropGate.Exit();
                }
            }
            finally
            {
                deferral.Complete();
            }
        }

        private async Task RunDropMountAsync(DataPackageView dataView)
        {
            IReadOnlyList<IStorageItem> items;
            try
            {
                items = await dataView.GetStorageItemsAsync();
            }
            catch (Exception ex)
            {
                DiagLog.Write($"[drop] GetStorageItemsAsync failed: {ex.Message}");
                return;
            }

            var paths = items.Select(i => i.Path).Where(p => !string.IsNullOrEmpty(p)).ToList();
            if (paths.Count == 0)
                return;

            // Classify does real Directory.Exists/File.Exists checks per
            // dropped path — off the UI thread (#2754 review, BLOCKING-2),
            // same reasoning EditSessionViewModel.Library.cs's
            // InitializeLibrary/RebuildFolderTree already document: a dead
            // network share can block Exists for the OS's own timeout, and
            // that must never freeze the window. LibraryFolders is
            // snapshotted on the UI thread first — it's an
            // ObservableCollection, not safe to read concurrently with a
            // UI-thread mutation (AddLibraryFolder/RemoveLibraryFolder).
            var libraryRootsSnapshot = ViewModel.LibraryFolders.ToList();
            var plan = await Task.Run(() => DropMountLogic.Classify(paths, libraryRootsSnapshot));
            switch (plan.Kind)
            {
                case DropOutcomeKind.Unsupported:
                    await ShowMessageAsync("Can't open that",
                        plan.UnsupportedReason ?? "Nothing usable was dropped.");
                    return;
                case DropOutcomeKind.OpenFile:
                    await OpenDroppedFileAsync(plan);
                    return;
                case DropOutcomeKind.Browse:
                    await BrowseDroppedFilesAsync(plan);
                    return;
            }
        }

        /// <summary>Case 1 (single file): mount its parent (unless it's
        /// already inside a mounted source — case 4 folds in here too,
        /// since <paramref name="plan"/>.MountRoot is already null in that
        /// case) and open that photo directly in Full Image (Preview).</summary>
        private async Task OpenDroppedFileAsync(DropMountPlan plan)
        {
            if (plan.MountRoot != null)
                await ViewModel.AddLibraryFolderAsync(plan.MountRoot);
            else
                await ViewModel.LoadDirectoryAsync(plan.NavigateFolder);

            var resolved = ViewModel.ResolveDroppedPhotos(plan.SelectFiles);
            if (resolved.Count == 0)
            {
                // Raced away between the drop and the scan, or genuinely
                // unreadable — land in Browse at the folder rather than
                // leaving the shell in a half-navigated state.
                SetMode(ShellMode.Browse);
                AnnounceRename("Couldn't open the dropped photo.");
                return;
            }
            ViewModel.SelectedPhoto = resolved[0];
            SetMode(ShellMode.Preview);
        }

        /// <summary>Case 2 (folder) and case 3 (multiple loose files): mount
        /// (unless already-mounted, case 4) and land in Browse, selecting
        /// whichever dropped items resolved to real files — empty for a
        /// folder-only drop, the dropped files themselves for a
        /// multi-file drop.</summary>
        private async Task BrowseDroppedFilesAsync(DropMountPlan plan)
        {
            if (plan.MountRoot != null)
                await ViewModel.AddLibraryFolderAsync(plan.MountRoot);
            else
                await ViewModel.LoadDirectoryAsync(plan.NavigateFolder);

            SetMode(ShellMode.Browse);

            if (plan.SelectFiles.Count == 0)
                return;
            var resolved = ViewModel.ResolveDroppedPhotos(plan.SelectFiles);
            if (resolved.Count == 0)
                return;

            // Selection lives on GridView.SelectedItems itself (see
            // MainWindow.Selection.cs's header comment) — there's no
            // ViewModel-side setter for it, so this drives the control
            // directly the same way a Ctrl-click multi-select would.
            PhotoGrid.SelectedItems.Clear();
            foreach (var photo in resolved)
                PhotoGrid.SelectedItems.Add(photo);
        }
    }
}
