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
using Maple.UI.Atoms;
using Maple.WinUI.Services;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        // Guards the whole confirm → progress → report flow below against a
        // re-entrant second call — key-repeat on a held Delete key, or a
        // second trigger landing in the gap between the confirm dialog
        // closing and the progress dialog presenting, would otherwise try
        // to open a second ContentDialog while WinUI only allows one, and
        // OnDeleteSelectedPhotos's fire-and-forget `_ =`/keyboard-handler
        // call site has nothing to observe that throw. See
        // Services/SingleFlightGate.cs.
        private readonly SingleFlightGate _deleteGate = new();

        private async void OnDeleteSelectedPhotos(object sender, RoutedEventArgs e) =>
            await RunDeleteSelectedPhotosAsync();

        private async Task RunDeleteSelectedPhotosAsync()
        {
            if (!_deleteGate.TryEnter())
                return;
            try
            {
                await RunDeleteSelectedPhotosCoreAsync();
            }
            finally
            {
                _deleteGate.Exit();
            }
        }

        /// <summary>Off the UI thread (#2948): TrashSelectionLogic.
        /// PredictDestinationKind ultimately calls LocalFileOperations.
        /// IsOnLocalFixedDrive -> `new DriveInfo(root).DriveType`, once per
        /// eligible item — a disconnected or sleeping mapped drive stalls
        /// each of those calls for the OS timeout, and this runs BEFORE the
        /// confirmation dialog opens (its copy needs the real counts), so
        /// doing it on the UI thread freezes the window for the whole
        /// selection before the user even sees a dialog. Awaited, not
        /// fire-and-forget, so the confirmation never opens with stale or
        /// half-computed counts — same Task.Run-to-the-thread-pool pattern
        /// InitializeLibrary documents (EditSessionViewModel.Library.cs).
        /// The window itself stays interactive for the duration (moves,
        /// resizes, repaints) since nothing blocks the dispatcher thread
        /// while this awaits.</summary>
        private static Task<(int RecycleBinCount, int MapleTrashCount)> ComputeTrashDestinationCountsAsync(
            IReadOnlyList<PhotoItem> eligible) =>
            Task.Run(() =>
            {
                var recycleBinCount = eligible.Count(p =>
                    TrashSelectionLogic.PredictDestinationKind(p.FilePath) == TrashDestinationKind.RecycleBin);
                return (recycleBinCount, eligible.Count - recycleBinCount);
            });

        private async Task RunDeleteSelectedPhotosCoreAsync()
        {
            var selection = ViewModel.SelectedPhotos;
            var eligible = EditSessionViewModel.TrashEligible(selection);
            // Cloud photos delete through the server's Trash (#2741) —
            // possible only while a cloud session is signed in.
            var cloudSelected = EditSessionViewModel.CloudTrashEligible(selection);
            var cloudEligible = ViewModel.CloudTrashAvailable
                ? cloudSelected
                : Array.Empty<PhotoItem>();
            if (eligible.Count == 0 && cloudEligible.Count == 0)
            {
                var message = selection.Count == 0
                    ? "Select one or more photos in the grid first."
                    : "These are Cloud photos and no Maple Cloud session is signed in — sign in "
                      + "(File → Connect to Maple Cloud…) to delete them.";
                await ShowMessageAsync("Delete", message);
                return;
            }
            var skippedCloud = cloudSelected.Count - cloudEligible.Count;
            var total = eligible.Count + cloudEligible.Count;

            var (recycleBinCount, mapleTrashCount) = await ComputeTrashDestinationCountsAsync(eligible);

            if (!await ConfirmDeleteAsync(total, recycleBinCount, mapleTrashCount, cloudEligible.Count, skippedCloud))
                return;

            var sources = EditSessionViewModel.BuildTrashSources(eligible);

            var statusText = new MuiText
            {
                Text = $"Deleting 0 of {total}…",
                Variant = MuiTextVariant.Body,
                Width = 380,
            };
            var progressDialog = new ContentDialog
            {
                Title = "Deleting photos…",
                Content = new StackPanel
                {
                    Spacing = 10,
                    Children = { new MuiProgress { ProgressShape = MuiProgressShape.Bar, IsIndeterminate = true }, statusText },
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
            IReadOnlyList<EditSessionViewModel.CloudTrashOutcome> cloudOutcomes =
                Array.Empty<EditSessionViewModel.CloudTrashOutcome>();
            Exception? unexpected = null;
            try
            {
                if (sources.Count > 0)
                    outcomes = await ViewModel.ApplyTrashAsync(sources,
                        (done, _) => OnUiThread(() => statusText.Text = $"Deleting {done} of {total}…"));
                if (cloudEligible.Count > 0)
                    cloudOutcomes = await ViewModel.ApplyCloudTrashAsync(cloudEligible,
                        (done, _) => OnUiThread(() =>
                            statusText.Text = $"Deleting {sources.Count + done} of {total}…"));
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

            // Cloud grid removal is explicit — no LibraryWatcher observes
            // the server's filesystem (see EditSessionViewModel.Trash.cs).
            var trashedCloud = cloudOutcomes.Where(o => o.Ok).Select(o => o.Photo).ToList();
            ViewModel.RemoveCloudPhotos(trashedCloud);

            if (unexpected != null)
            {
                AnnounceRename("Delete failed.");
                await ShowMessageAsync("Delete failed",
                    $"An unexpected error stopped the delete partway through: {unexpected.Message}\n\n"
                    + "Photos already deleted before the error stay deleted; check the grid for what "
                    + "went through.");
                return;
            }

            await ReportDeleteOutcomeAsync(outcomes, cloudOutcomes);
        }

        /// <summary>Shows the count-aware "N photos will move to the
        /// Recycle Bin, M to Maple's own trash" copy the design doc's
        /// visible-asymmetry requirement calls for, then asks for
        /// confirmation. The primary button reads "Move to Recycle Bin" or
        /// "Move to Maple Trash" for a same-destination batch, and a plain
        /// "Delete N Photos" for a mixed one.</summary>
        private async Task<bool> ConfirmDeleteAsync(
            int total, int recycleBinCount, int mapleTrashCount, int cloudCount, int skippedCloud)
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
            if (cloudCount > 0)
            {
                lines.Add(cloudCount == total
                    ? "Moves to your Maple Cloud server's Trash — restorable from File → Restore from "
                      + "Maple Trash…."
                    : $"{cloudCount} of {total} move to your Maple Cloud server's Trash — restorable from "
                      + "File → Restore from Maple Trash….");
            }
            if (skippedCloud > 0)
                lines.Add($"{skippedCloud} Cloud photo{(skippedCloud == 1 ? "" : "s")} skipped — no Maple "
                    + "Cloud session is signed in.");

            var primaryText = (recycleBinCount > 0, mapleTrashCount > 0, cloudCount > 0) switch
            {
                (true, false, false) => "Move to Recycle Bin",
                (false, true, false) => "Move to Maple Trash",
                (false, false, true) => "Move to Cloud Trash",
                _ => $"Delete {total} Photo{(total == 1 ? "" : "s")}",
            };

            var dialog = new ContentDialog
            {
                Title = total == 1 ? "Delete this photo?" : $"Delete {total} photos?",
                Content = new MuiText { Text = string.Join("\n\n", lines), Variant = MuiTextVariant.Body },
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

        private async Task ReportDeleteOutcomeAsync(
            IReadOnlyList<TrashItemOutcome> outcomes,
            IReadOnlyList<EditSessionViewModel.CloudTrashOutcome> cloudOutcomes)
        {
            var trashed = outcomes.Count(o => o.Kind == TrashOutcomeKind.Trashed)
                + cloudOutcomes.Count(o => o.Ok);
            var totalCount = outcomes.Count + cloudOutcomes.Count;
            var failed = totalCount - trashed;

            var summary = failed == 0
                ? $"Deleted {trashed} photo{(trashed == 1 ? "" : "s")}."
                : $"Deleted {trashed} of {totalCount} photos. {failed} failed.";
            AnnounceRename(summary);

            if (failed == 0)
                return; // no dialog for the common all-success case — the confirmation already explained where things went

            var detail = new StackPanel { Spacing = 6 };
            foreach (var outcome in outcomes.Where(o => o.Kind == TrashOutcomeKind.Error))
            {
                detail.Children.Add(new MuiText
                {
                    Text = $"{outcome.FileName ?? "(unknown)"}: {outcome.Error ?? "unknown error"}",
                    Variant = MuiTextVariant.Body,
                });
            }
            foreach (var outcome in cloudOutcomes.Where(o => !o.Ok))
            {
                detail.Children.Add(new MuiText
                {
                    Text = $"{outcome.Photo.FileName}: {outcome.Error ?? "unknown error"}",
                    Variant = MuiTextVariant.Body,
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
