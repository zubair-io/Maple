// MainWindow.Reveal.cs — "Show in Explorer" (#2658, mirrors the Apple
// sibling's "Reveal in Finder"): the grid selection's right-click item and
// the sources-tree FOLDERS flyout's item. Both call the same
// `RevealInExplorer` helper; the eligibility/argument logic they build on
// lives in Services/FileOperations/RevealInFileManagerLogic.cs, WinUI-free
// and unit-tested there (RevealInFileManagerLogicTests) — this file is UI-
// thread mechanics only, the same split every other file-operations feature
// in this app uses (MainWindow.Trash.cs, MainWindow.FolderContextMenu.cs).
//
// `explorer.exe /select,"<path>"` is the same `Process.Start` +
// `ProcessStartInfo { UseShellExecute = true }` shape
// EditSessionViewModel.Cloud.cs's `StartBrowserSignInAsync` already uses to
// hand a URL to the shell — no P/Invoke needed, `UseShellExecute` routes
// through the OS the same way either time.

using System.Diagnostics;
using System.Linq;
using Microsoft.UI.Xaml;
using Maple.WinUI.Services.FileOperations;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        // --- Grid selection ---

        /// <summary>Gates the grid's "Show in Explorer" item — HIDDEN, not
        /// disabled, when nothing in the current selection has a local
        /// path (an all-Cloud selection, or nothing selected at
        /// all).</summary>
        private void OnPhotoGridContextFlyoutOpening(object? sender, object e)
        {
            var eligible = RevealInFileManagerLogic.EligiblePaths(
                ViewModel.SelectedPhotos.Select(p => (p.FilePath, p.IsCloud)));
            var visible = eligible.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
            RevealInExplorerMenuItem.Visibility = visible;
            RevealInExplorerSeparator.Visibility = visible;
        }

        /// <summary>Reveals the first eligible photo in the active grid
        /// selection — see RevealInFileManagerLogic's file header for why
        /// "first" rather than one Explorer window per selected
        /// photo.</summary>
        private void OnRevealSelectedPhotosInExplorer(object sender, RoutedEventArgs e)
        {
            var target = RevealInFileManagerLogic.RevealTarget(
                ViewModel.SelectedPhotos.Select(p => (p.FilePath, p.IsCloud)));
            if (target != null)
                RevealInExplorer(target);
        }

        // --- Sources-tree FOLDERS flyout ---

        /// <summary>Every FOLDERS-tree row is a local (or SMB/UNC) path by
        /// construction (see EditSessionViewModel.FolderCrud.cs's header —
        /// Cloud lives in its own "MAPLE CLOUD" ListView, not this tree),
        /// so unlike the grid this item needs no eligibility gate — only
        /// the same "still-loading placeholder row" guard every other
        /// action in this flyout already applies via
        /// ResolveFolderContextTargetAsync.</summary>
        private async void OnRevealFolderInExplorer(object sender, RoutedEventArgs e)
        {
            if (await ResolveFolderContextTargetAsync(sender) is not { } node)
                return;
            RevealInExplorer(node.Path);
        }

        // --- Shared ---

        private static void RevealInExplorer(string path)
        {
            Process.Start(new ProcessStartInfo(
                "explorer.exe", RevealInFileManagerLogic.SelectArgument(path))
            {
                UseShellExecute = true,
            });
        }
    }
}
