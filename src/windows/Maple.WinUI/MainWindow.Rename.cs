// MainWindow.Rename.cs — inline single-asset rename UI wiring (#2639).
// Entry points: F2 on the resolved rename target (OnRootKeyDown,
// MainWindow.xaml.cs) and double-clicking the filename TextBlock in a grid
// cell (OnFileNameDoubleTapped, wired in MainWindow.xaml). Both call
// StartRename, which flips the cell into edit mode via
// EditSessionViewModel.BeginRename and focuses the field once the grid's
// virtualized container has laid it out. All validation/relocate logic
// lives in EditSessionViewModel.Rename.cs — this file is UI-thread
// mechanics only (focus, text selection, ToolTip placement, Narrator
// announcements).

using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.System;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        /// <summary>Photos currently mid-commit — guards against a race
        /// between the Enter-key commit and the LostFocus commit that
        /// follows it (the field loses focus as it collapses back to a
        /// TextBlock once IsRenaming flips false). A relocate over SMB can
        /// take real time, and both handlers would otherwise be able to
        /// call CommitRenameAsync concurrently for the same photo.</summary>
        private readonly HashSet<PhotoItem> _renameCommitInFlight = new();

        private void OnFileNameDoubleTapped(object sender, DoubleTappedRoutedEventArgs e)
        {
            if (sender is not FrameworkElement { DataContext: PhotoItem photo })
                return;
            // Stop this from bubbling to the GridView's own DoubleTapped
            // (OnGridDoubleTapped), which would otherwise open the photo in
            // Preview instead of starting the rename.
            e.Handled = true;
            StartRename(photo);
        }

        private void OnRenameTextBoxDoubleTapped(object sender, DoubleTappedRoutedEventArgs e) =>
            e.Handled = true;

        /// <summary>Enters rename mode for <paramref name="photo"/> and
        /// focuses the field once the grid has laid out its (possibly just
        /// virtualized) container.</summary>
        private void StartRename(PhotoItem photo)
        {
            ViewModel.BeginRename(photo);
            PhotoGrid.ScrollIntoView(photo);
            App.MainDispatcherQueue?.TryEnqueue(() => FocusRenameField(photo));
        }

        /// <summary>Focuses the rename TextBox for <paramref name="photo"/>
        /// and pre-selects its stem (base name, no extension) — typing
        /// replaces just the base name, matching the design doc's
        /// "extension preserved by default." A no-op if the item's
        /// container isn't realized (virtualized out of view) or the
        /// TextBox isn't found — BeginRename already flipped IsRenaming, so
        /// the field still shows correctly once it does become visible.</summary>
        private void FocusRenameField(PhotoItem photo)
        {
            if (PhotoGrid.ContainerFromItem(photo) is not GridViewItem container)
                return;
            if (FindDescendant<TextBox>(container) is not { } box)
                return;
            box.Focus(FocusState.Programmatic);
            var stem = RenameLogic.Stem(box.Text);
            box.Select(0, stem.Length);
        }

        private async void OnRenameTextBoxKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (sender is not TextBox box || box.DataContext is not PhotoItem photo)
                return;

            if (e.Key == VirtualKey.Escape)
            {
                e.Handled = true;
                ViewModel.CancelRename(photo);
                AnnounceRename("Rename canceled.");
                return;
            }
            if (e.Key != VirtualKey.Enter)
                return;

            e.Handled = true;
            await CommitRenameFromUiAsync(box, photo);
        }

        private async void OnRenameTextBoxLostFocus(object sender, RoutedEventArgs e)
        {
            if (sender is not TextBox box || box.DataContext is not PhotoItem photo || !photo.IsRenaming)
                return;
            await CommitRenameFromUiAsync(box, photo);
        }

        /// <summary>Shared commit path for both Enter and focus-loss. On
        /// success, announces the outcome to Narrator. On rejection: if the
        /// field is still focused (an Enter-key rejection —
        /// EditSessionViewModel.CommitRenameAsync leaves IsRenaming true so
        /// the field stays open for correction), opens a ToolTip anchored to
        /// it with the reason (this ticket's "surface rejections inline next
        /// to the field") and re-selects the text. If the field has already
        /// lost focus (the user clicked away instead of fixing it), there is
        /// nothing sensible left to keep open, so the edit is discarded via
        /// CancelRename instead.</summary>
        private async Task CommitRenameFromUiAsync(TextBox box, PhotoItem photo)
        {
            if (!_renameCommitInFlight.Add(photo))
                return;
            try
            {
                // The classic {Binding Mode=TwoWay} on TextBox.Text (MainWindow.xaml)
                // flushes to the source on LostFocus by default — Enter alone
                // doesn't move focus, so without this, an Enter-triggered
                // commit would read whatever RenameText held BEFORE this
                // keystroke (the seeded original name) rather than what's
                // actually in the box right now.
                photo.RenameText = box.Text;
                var previousName = photo.FileName;
                var committed = await ViewModel.CommitRenameAsync(photo);
                if (committed)
                {
                    AnnounceRename(string.Equals(previousName, photo.FileName, StringComparison.Ordinal)
                        ? "Rename canceled — no change."
                        : $"Renamed to {photo.FileName}.");
                    return;
                }

                var reason = photo.RenameError ?? "Rename failed.";
                if (box.FocusState != FocusState.Unfocused)
                {
                    // Still focused (an Enter-key rejection) — keep the
                    // field open for correction, message right next to it.
                    var tip = new ToolTip { Content = reason, PlacementTarget = box, IsOpen = true };
                    ToolTipService.SetToolTip(box, tip);
                    box.SelectAll();
                }
                else
                {
                    // Lost focus mid-edit with a rejected name — nothing
                    // sensible to keep open without focus.
                    ViewModel.CancelRename(photo);
                }
                AnnounceRename(reason);
            }
            finally
            {
                _renameCommitInFlight.Remove(photo);
            }
        }

        private void AnnounceRename(string message)
        {
            // Assign only on change: RenameStatusText is a Polite live
            // region, and re-assigning identical text re-announces it to
            // Narrator (same convention as UpdateLibraryCountText,
            // MainWindow.Selection.cs).
            if (RenameStatusText.Text != message)
                RenameStatusText.Text = message;
        }

        private static T? FindDescendant<T>(DependencyObject root) where T : DependencyObject
        {
            var count = VisualTreeHelper.GetChildrenCount(root);
            for (var i = 0; i < count; i++)
            {
                var child = VisualTreeHelper.GetChild(root, i);
                if (child is T match)
                    return match;
                var found = FindDescendant<T>(child);
                if (found != null)
                    return found;
            }
            return null;
        }
    }
}
