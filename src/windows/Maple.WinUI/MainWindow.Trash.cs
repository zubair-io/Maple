// MainWindow.Trash.cs — Delete → Trash UI wiring for the grid selection
// (#2654): the Delete key (OnRootKeyDown, MainWindow.xaml.cs), the Photo
// menu's "Delete…" item, and PhotoGrid's own right-click ContextFlyout (all
// three, MainWindow.xaml, call OnDeleteSelectedPhotos, so no entry point
// can drift from another).
//
// Confirmation copy calls out the asymmetry the design doc requires stay
// visible: a local-fixed-drive delete goes to the Windows Recycle Bin
// (recoverable from File Explorer); everything else (SMB, or a Recycle Bin
// attempt that itself failed) goes to Maple's own `.maple/trash/<rel>`,
// restorable from "Restore from Maple Trash…" (File menu,
// MainWindow.TrashRestore.cs) — never a second in-app Recycle Bin browser.
//
// All relocate logic lives in EditSessionViewModel.Trash.cs and
// Services/FileOperations/TrashSelectionLogic.cs; this file is UI-thread
// mechanics only (confirmation copy, the progress dialog's try/finally
// teardown with the failure re-surfaced, the outcome report, and the
// Narrator announcement) — the same split every other file-operations
// feature in this app (MainWindow.BatchRename.cs, MainWindow.DragDrop.cs)
// uses.

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        private async void OnDeleteSelectedPhotos(object sender, RoutedEventArgs e) =>
            await RunDeleteSelectedPhotosAsync();

        private async Task RunDeleteSelectedPhotosAsync()
        {
            var selection = ViewModel.SelectedPhotos;
            var eligible = EditSessionViewModel.TrashEligible(selection);
            if (eligible.Count == 0)
            {
                var message = selection.Count == 0
                    ? "Select one or more photos in the grid first."
                    : "Cloud photos can't be deleted here yet — delete them from the source "
                      + "library (tracked separately, #2741).";
                await ShowMessageAsync("Delete", message);
                return;
            }
            var skippedCloud = selection.Count - eligible.Count;

            var recycleBinCount = eligible.Count(p =>
                TrashSelectionLogic.PredictDestinationKind(p.FilePath) == TrashDestinationKind.RecycleBin);
            var mapleTrashCount = eligible.Count - recycleBinCount;

            if (!await ConfirmDeleteAsync(eligible.Count, recycleBinCount, mapleTrashCount, skippedCloud))
                return;

            var sources = EditSessionViewModel.BuildTrashSources(eligible);

            var statusText = new TextBlock
            {
                Text = $"Deleting 0 of {sources.Count}…",
                FontSize = 12,
                Width = 380,
                TextWrapping = TextWrapping.Wrap,
            };
            var progressDialog = new ContentDialog
            {
                Title = "Deleting photos…",
                Content = new StackPanel
                {
                    Spacing = 10,
                    Children = { new ProgressBar { IsIndeterminate = true }, statusText },
                },
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            var progressShown = progressDialog.ShowAsync();

            // Same try/finally teardown as RunBatchRenameAsync/
            // RunDragMoveAsync (#2642 review requirement): the dialog has
            // no Cancel affordance, so an unexpected throw must still bring
            // it down rather than covering the app forever, and the catch
            // re-surfaces the failure instead of letting `finally`
            // silently swallow it.
            IReadOnlyList<TrashItemOutcome> outcomes = Array.Empty<TrashItemOutcome>();
            Exception? unexpected = null;
            try
            {
                outcomes = await ViewModel.ApplyTrashAsync(sources,
                    (done, total) => OnUiThread(() => statusText.Text = $"Deleting {done} of {total}…"));
            }
            catch (Exception ex)
            {
                unexpected = ex;
            }
            finally
            {
                progressDialog.Hide();
                await progressShown;
            }

            if (unexpected != null)
            {
                AnnounceRename("Delete failed.");
                await ShowMessageAsync("Delete failed",
                    $"An unexpected error stopped the delete partway through: {unexpected.Message}\n\n"
                    + "Photos already deleted before the error stay deleted; check the grid for what "
                    + "went through.");
                return;
            }

            await ReportDeleteOutcomeAsync(outcomes);
        }

        /// <summary>Shows the count-aware "N photos will move to the
        /// Recycle Bin, M to Maple's own trash" copy the design doc's
        /// visible-asymmetry requirement calls for, then asks for
        /// confirmation. The primary button reads "Move to Recycle Bin" or
        /// "Move to Maple Trash" for a same-destination batch, and a plain
        /// "Delete N Photos" for a mixed one.</summary>
        private async Task<bool> ConfirmDeleteAsync(
            int total, int recycleBinCount, int mapleTrashCount, int skippedCloud)
        {
            var lines = new List<string>();
            if (recycleBinCount > 0)
            {
                lines.Add(recycleBinCount == total
                    ? "Moves to the Windows Recycle Bin — recoverable from File Explorer."
                    : $"{recycleBinCount} of {total} move to the Windows Recycle Bin — recoverable from "
                      + "File Explorer.");
            }
            if (mapleTrashCount > 0)
            {
                lines.Add(mapleTrashCount == total
                    ? "Moves to Maple's own trash folder (network locations don't have a reliable "
                      + "Recycle Bin) — restorable from File → Restore from Maple Trash…."
                    : $"{mapleTrashCount} of {total} move to Maple's own trash folder (network locations "
                      + "don't have a reliable Recycle Bin) — restorable from File → Restore from Maple "
                      + "Trash….");
            }
            if (skippedCloud > 0)
                lines.Add($"{skippedCloud} Cloud photo{(skippedCloud == 1 ? "" : "s")} skipped (can't delete "
                    + "here yet).");

            var primaryText = mapleTrashCount == 0
                ? "Move to Recycle Bin"
                : recycleBinCount == 0
                    ? "Move to Maple Trash"
                    : $"Delete {total} Photo{(total == 1 ? "" : "s")}";

            var dialog = new ContentDialog
            {
                Title = total == 1 ? "Delete this photo?" : $"Delete {total} photos?",
                Content = new TextBlock { Text = string.Join("\n\n", lines), TextWrapping = TextWrapping.Wrap },
                PrimaryButtonText = primaryText,
                CloseButtonText = "Cancel",
                // Escape/dismiss defaults to Cancel, not the destructive
                // action — same "safe implicit choice" the drag-move
                // collision dialog (MainWindow.DragDrop.cs) already applies.
                DefaultButton = ContentDialogButton.Close,
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            return await dialog.ShowAsync() == ContentDialogResult.Primary;
        }

        private async Task ReportDeleteOutcomeAsync(IReadOnlyList<TrashItemOutcome> outcomes)
        {
            var trashed = outcomes.Count(o => o.Kind == TrashOutcomeKind.Trashed);
            var failed = outcomes.Count - trashed;

            var summary = failed == 0
                ? $"Deleted {trashed} photo{(trashed == 1 ? "" : "s")}."
                : $"Deleted {trashed} of {outcomes.Count} photos. {failed} failed.";
            AnnounceRename(summary);

            if (failed == 0)
                return; // no dialog for the common all-success case — the confirmation already explained where things went

            var detail = new StackPanel { Spacing = 6 };
            foreach (var outcome in outcomes.Where(o => o.Kind == TrashOutcomeKind.Error))
            {
                detail.Children.Add(new TextBlock
                {
                    Text = $"{outcome.FileName ?? "(unknown)"}: {outcome.Error ?? "unknown error"}",
                    FontSize = 12,
                    TextWrapping = TextWrapping.Wrap,
                });
            }
            var reportDialog = new ContentDialog
            {
                Title = $"Delete — {summary}",
                Content = new ScrollViewer { Content = detail, MaxHeight = 320 },
                CloseButtonText = "OK",
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            await reportDialog.ShowAsync();
        }
    }
}
