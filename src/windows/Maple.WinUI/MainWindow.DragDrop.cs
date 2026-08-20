// MainWindow.DragDrop.cs — drag assets onto the sources tree (#2648):
// CanDragItems/DragItemsStarting on PhotoGrid (MainWindow.xaml), AllowDrop/
// DragEnter/DragLeave/DragOver/Drop on each FOLDERS TreeViewItem (same XAML
// file). Default drag = move; holding Ctrl while dragging = copy (design
// doc's "the platform copy-modifier"). Collisions ask (Skip / Replace / Keep
// Both) via CollisionDialogAsync — the same modal both this file and
// MainWindow.MoveToFolder.cs (the keyboard/Narrator-accessible equivalent)
// show, because RunDragMoveAsync below is the one shared apply path for
// both entry points; neither reimplements the other. All validation/relocate
// logic lives in EditSessionViewModel.DragMove.cs and
// Services/FileOperations/DragMoveLogic.cs — this file is UI-thread
// mechanics only (drag payload capture, drop-target highlight, the
// collision/progress/report dialogs), the same split MainWindow.Rename.cs /
// EditSessionViewModel.Rename.cs and MainWindow.BatchRename.cs /
// EditSessionViewModel.BatchRename.cs already use.
//
// Per the design doc, drop targets are sources-tree folder nodes only — no
// grid-to-grid reordering, and dragging assets OUT to Explorer is out of
// scope for this ticket (the issue says so explicitly).

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.ApplicationModel.DataTransfer;
using Windows.ApplicationModel.DataTransfer.DragDrop;
using Maple.WinUI.Services;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        /// <summary>The photos a drag gesture is currently carrying — set in
        /// OnPhotoGridDragItemsStarting, read back in OnFolderDrop. WinUI's
        /// DataPackage is built for cross-process transfer (files, text,
        /// bitmaps); since the drag never leaves this window, the actual
        /// PhotoItem identities travel via this field instead — the
        /// DataPackage still carries a plain-text summary (SetText below) so
        /// the drag has real payload and a sensible drag-visual caption.
        /// Cleared in OnPhotoGridDragItemsCompleted, which WinUI guarantees
        /// fires however the drag ends — a successful drop, a drop rejected
        /// by every target, or an outright cancel (Esc) — unlike relying on
        /// OnFolderDrop alone, which only runs on an actual drop and would
        /// leave a cancelled drag's payload sitting here indefinitely. Even
        /// so, OnFolderDrop does not trust this field's mere non-emptiness
        /// to mean "the current drop is ours" — see IsInternalDrag — since a
        /// missed lifecycle path here would otherwise let a LATER, unrelated
        /// drop (including one dragged in from outside this process, e.g.
        /// Windows Explorer) silently relocate whatever this field still
        /// held.</summary>
        private IReadOnlyList<PhotoItem> _dragPayload = Array.Empty<PhotoItem>();

        /// <summary>App-private DataPackage format id stamped onto every
        /// drag PhotoGrid starts (OnPhotoGridDragItemsStarting) — the marker
        /// OnFolderDragOver/OnFolderDrop check via IsInternalDrag before
        /// trusting _dragPayload or accepting the drop at all. A drag
        /// originating anywhere else (Windows Explorer, another app) never
        /// carries this format, so it can never be mistaken for an internal
        /// PhotoGrid drag no matter what stale field state happens to be
        /// sitting around.</summary>
        private const string InternalDragFormatId = "Maple.WinUI.PhotoGridDrag";

        // --- Modal-flow re-entrancy guard (#2948) ---

        /// <summary>Shared re-entrancy guard for every flow below that shows
        /// a modal ContentDialog sequence and isn't already covered by a
        /// narrower gate of its own: RunDragMoveAsync (reachable from
        /// OnFolderDrop below AND MainWindow.MoveToFolder.cs's
        /// OnMoveToFolder), MainWindow.BatchRename.cs's OnBatchRename, and
        /// MainWindow.Pano.cs's OnStitchPano. None of the four had ANY
        /// re-entrancy guard before #2948, unlike Delete/Restore (
        /// MainWindow.Trash.cs's _deleteGate, MainWindow.TrashRestore.cs's
        /// _restoreGate — same hazard, #2743): two overlapping invocations
        /// of an `async void` handler that shows a ContentDialog throw
        /// inside the second ShowAsync(), since WinUI only allows one
        /// ContentDialog open at a time and an `async void` entry point has
        /// nothing to observe that throw — it crashes the app.
        ///
        /// One shared gate (rather than four separate ones, mirroring
        /// Delete/Restore) is deliberate: these four don't just need
        /// guarding against re-entering THEMSELVES, they need guarding
        /// against EACH OTHER too — a drag-drop landing while Batch
        /// Rename's dialog is still open hits the identical
        /// second-ShowAsync crash, because a ContentDialog from one flow
        /// blocks a ContentDialog from any other regardless of which flow
        /// opened it first. Delete/Restore deliberately stay on their own
        /// separate gates rather than folding into this one: they already
        /// have real per-flow protection today, so merging them in would
        /// newly forbid e.g. restoring while a delete confirmation is up —
        /// an untested behavior change outside this ticket's scope. These
        /// four had no protection at all, so giving them one shared gate
        /// only prevents crashes; it doesn't take away anything that used
        /// to work.</summary>
        private readonly SingleFlightGate _modalFlowGate = new();

        /// <summary>Runs <paramref name="body"/> only if _modalFlowGate is
        /// free, silently dropping a re-entrant call otherwise — see that
        /// field's comment. Every `async void` entry point it covers calls
        /// this instead of awaiting its own body directly, the same
        /// try/finally shape MainWindow.Trash.cs's OnDeleteSelectedPhotos
        /// and MainWindow.TrashRestore.cs's OnRestoreFromMapleTrash already
        /// use per-flow.</summary>
        private async Task RunModalFlowGuardedAsync(Func<Task> body)
        {
            if (!_modalFlowGate.TryEnter())
                return;
            try
            {
                await body();
            }
            finally
            {
                _modalFlowGate.Exit();
            }
        }

        // --- Drag source: PhotoGrid (CanDragItems="True" in MainWindow.xaml) ---

        /// <summary>WinUI's ListViewBase already implements "drag a selected
        /// item and the whole selection travels; drag an unselected item and
        /// only that item travels, becoming the new selection" — exactly the
        /// design doc's "multi-select drag carries the whole selection if
        /// the dragged item is part of it" — so args.Items is already the
        /// correct payload with no extra logic needed here. Cloud photos are
        /// filtered out (DragMoveEligible); a drag that turns out to be
        /// all-Cloud is canceled outright rather than starting a drag that
        /// can only ever fail.</summary>
        private void OnPhotoGridDragItemsStarting(object sender, DragItemsStartingEventArgs e)
        {
            var eligible = EditSessionViewModel.DragMoveEligible(
                e.Items.OfType<PhotoItem>().ToList());
            if (eligible.Count == 0)
            {
                e.Cancel = true;
                return;
            }
            _dragPayload = eligible;
            // The actual payload travels via _dragPayload (in-process, so no
            // WinRT marshalling needed for the PhotoItem identities). This
            // plain-text form is what gives the DataPackage real content —
            // required for the drag to visually start at all — and what a
            // drop target outside this window (there is none in scope for
            // this ticket) would see instead of nothing.
            e.Data.SetText(string.Join("\n", eligible.Select(p => p.FilePath)));
            // The marker IsInternalDrag checks — never read back through
            // GetDataAsync, only Contains(), so the `true` value is never
            // actually consumed.
            e.Data.SetData(InternalDragFormatId, true);
            e.Data.RequestedOperation = DataPackageOperation.Move | DataPackageOperation.Copy;
        }

        /// <summary>Fires however THIS drag ends — dropped on a valid
        /// target, dropped on nothing that accepted it, or cancelled
        /// outright (Esc) — which is what makes this the correct place to
        /// retire _dragPayload rather than OnFolderDrop, which only runs on
        /// an actual successful drop.</summary>
        private void OnPhotoGridDragItemsCompleted(object sender, DragItemsCompletedEventArgs e)
        {
            _dragPayload = Array.Empty<PhotoItem>();
        }

        /// <summary>True only for a drag PhotoGrid itself started — see
        /// InternalDragFormatId. Both OnFolderDragOver and OnFolderDrop
        /// check this before doing anything with _dragPayload, so an
        /// external drag (Explorer, another app) is inert here even if
        /// OnPhotoGridDragItemsCompleted's cleanup were ever missed for some
        /// other internal drag — defense in depth, not the only guard.</summary>
        private static bool IsInternalDrag(DragEventArgs e) => e.DataView.Contains(InternalDragFormatId);

        // --- Drop target: each FOLDERS TreeViewItem (AllowDrop="True" in MainWindow.xaml) ---

        private void OnFolderDragEnter(object sender, DragEventArgs e)
        {
            // Background is a Control property (TreeViewItem : Control), not
            // a bare FrameworkElement one. Gated on IsInternalDrag first: an
            // external drag (Explorer, another app) should never highlight
            // a folder row as a target this feature doesn't handle yet.
            // Beyond that, only the coarse "is this even a real folder node"
            // check runs here (no payload/self-drop analysis — that's
            // OnFolderDragOver's job, which also drives the actual
            // accept/reject cursor); a placeholder expander stub, or an
            // unavailable library root (#2754), never highlights as
            // a target.
            if (IsInternalDrag(e)
                && sender is Control { DataContext: FolderNode node } control
                && DragMoveLogic.IsEligibleDropTargetNode(
                    node.IsPlaceholder, node.IsUnavailable, !string.IsNullOrEmpty(node.Path)))
                control.Background = (SolidColorBrush)Application.Current.Resources["MaplePrimaryDim"];
        }

        private void OnFolderDragLeave(object sender, DragEventArgs e)
        {
            if (sender is Control control)
                control.ClearValue(Control.BackgroundProperty);
        }

        private void OnFolderDragOver(object sender, DragEventArgs e)
        {
            // Not our drag (e.g. Windows Explorer dragging files in) — leave
            // AcceptedOperation untouched rather than marking this handled,
            // so the drop falls through cleanly for future work (#2649/
            // #2651 drop-to-mount) instead of this handler silently
            // swallowing a gesture it has no business interpreting.
            if (!IsInternalDrag(e))
                return;

            e.Handled = true;
            var hasTarget = TryResolveDropTarget(sender, out _, out var applicableSources);
            if (!DragMoveLogic.ShouldAcceptDrop(isInternalDrag: true, hasTarget))
            {
                e.AcceptedOperation = DataPackageOperation.None;
                return;
            }

            var copy = e.Modifiers.HasFlag(DragDropModifiers.Control);
            e.AcceptedOperation = copy ? DataPackageOperation.Copy : DataPackageOperation.Move;
            e.DragUIOverride.IsCaptionVisible = true;
            e.DragUIOverride.Caption = BuildDragCaption(applicableSources.Count, copy);
            e.DragUIOverride.IsGlyphVisible = true;
        }

        private async void OnFolderDrop(object sender, DragEventArgs e)
        {
            if (sender is Control resetTarget)
                resetTarget.ClearValue(Control.BackgroundProperty);

            // Same guard as OnFolderDragOver, and the load-bearing one: this
            // is what stops a drop from ever consuming _dragPayload unless
            // the CURRENT drop actually originated from this app's own
            // PhotoGrid — not "whatever _dragPayload happens to still hold,"
            // which a missed cleanup path could otherwise leave stale after
            // a cancelled internal drag.
            if (!IsInternalDrag(e))
                return;

            e.Handled = true;
            var hasTarget = TryResolveDropTarget(sender, out var node, out var applicableSources);
            if (!DragMoveLogic.ShouldAcceptDrop(isInternalDrag: true, hasTarget) || node == null)
                return;

            var payload = _dragPayload;
            if (payload.Count == 0)
                return;

            var copy = e.Modifiers.HasFlag(DragDropModifiers.Control);
            var mode = copy ? RelocateMode.Copy : RelocateMode.Move;
            await RunModalFlowGuardedAsync(() => RunDragMoveAsync(payload, node.Path, mode));
        }

        /// <summary>Resolves the FolderNode a drag/drop event is targeting
        /// and whether the CURRENT drag payload has at least one item that
        /// would actually relocate there. Returns false for every "invalid
        /// target" the design doc calls out: not a real folder node (a
        /// placeholder expander stub, or the event fired on something else
        /// entirely), or a whole-selection self-drop (every dragged item
        /// already lives in that exact folder) — both cases must be rejected
        /// BEFORE the drop, not accepted and then reported as an all-Skipped
        /// no-op.</summary>
        private bool TryResolveDropTarget(
            object sender, out FolderNode? node, out IReadOnlyList<DragMoveSourceItem> applicableSources)
        {
            node = null;
            applicableSources = Array.Empty<DragMoveSourceItem>();
            if (sender is not FrameworkElement { DataContext: FolderNode candidate }
                || !DragMoveLogic.IsEligibleDropTargetNode(
                    candidate.IsPlaceholder, candidate.IsUnavailable, !string.IsNullOrEmpty(candidate.Path)))
                return false;

            var sources = EditSessionViewModel.BuildDragMoveSources(_dragPayload);
            if (!EditSessionViewModel.DragMoveHasApplicableTarget(sources, candidate.Path))
                return false;

            node = candidate;
            applicableSources = sources.Where(s => !DragMoveLogic.IsAlreadyInDestination(s, candidate.Path)).ToList();
            return true;
        }

        private static string BuildDragCaption(int count, bool copy)
        {
            var verb = copy ? "Copy" : "Move";
            return count == 1 ? $"{verb} 1 photo" : $"{verb} {count} photos";
        }

        // --- Shared apply path: drag-drop AND "Move to Folder…" (MainWindow.MoveToFolder.cs) ---

        /// <summary>Detects collisions, asks Skip/Replace/Keep Both only if
        /// any exist, shows an uncancelable progress dialog while applying,
        /// and reports the outcome — the one code path both entry points
        /// this ticket ships (drag-drop here, the keyboard "Move to
        /// Folder…" dialog) funnel through, so neither can drift from the
        /// other's collision/report behavior.</summary>
        private async Task RunDragMoveAsync(IReadOnlyList<PhotoItem> photos, string destinationDir, RelocateMode mode)
        {
            var sources = EditSessionViewModel.BuildDragMoveSources(photos);
            var collidingKeys = EditSessionViewModel.DetectDragMoveCollisions(sources, destinationDir);

            var choice = collidingKeys.Count > 0
                ? await ShowCollisionDialogAsync(collidingKeys.Count)
                : DragMoveCollisionChoice.KeepBoth;

            var verb = mode == RelocateMode.Copy ? "Copying" : "Moving";
            var statusText = new TextBlock
            {
                Text = $"{verb} 0 of {photos.Count}…",
                FontSize = 12,
                Width = 380,
                TextWrapping = TextWrapping.Wrap,
            };
            var progressDialog = new ContentDialog
            {
                Title = $"{verb} photos…",
                Content = new StackPanel
                {
                    Spacing = 10,
                    Children = { new ProgressBar { IsIndeterminate = true }, statusText },
                },
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            var progressShown = progressDialog.ShowAsync();

            IReadOnlyList<DragMoveItemOutcome> outcomes = Array.Empty<DragMoveItemOutcome>();
            Exception? unexpected = null;
            try
            {
                outcomes = await ViewModel.ApplyDragMoveAsync(
                    photos, sources, destinationDir, mode, collidingKeys, choice,
                    (done, total) => OnUiThread(() => statusText.Text = $"{verb} {done} of {total}…"));
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

            var noun = mode == RelocateMode.Copy ? "copy" : "move";
            if (unexpected != null)
            {
                AnnounceRename($"{verb} failed.");
                await ShowMessageAsync($"{verb} photos",
                    $"An unexpected error stopped the {noun} partway through: {unexpected.Message}\n\n"
                    + "Photos already relocated before the error stay relocated; check the destination "
                    + "folder for what went through.");
                return;
            }

            await ReportDragMoveOutcomeAsync(mode, outcomes);
        }

        private async Task ReportDragMoveOutcomeAsync(RelocateMode mode, IReadOnlyList<DragMoveItemOutcome> outcomes)
        {
            var verbPast = mode == RelocateMode.Copy ? "Copied" : "Moved";
            var relocated = outcomes.Count(o => o.Kind == DragMoveOutcomeKind.Relocated);
            var skipped = outcomes.Count(o => o.Kind == DragMoveOutcomeKind.Skipped);
            var failed = outcomes.Count(o => o.Kind == DragMoveOutcomeKind.Error);
            // A Relocated outcome can still carry a Note — DragMoveLogic set
            // one when it overrode the chosen collision policy because this
            // item's destination name was already claimed by an earlier
            // item from the SAME drop (see DragMoveLogic.ApplyOneAsync).
            // Those need to surface too, not just Skipped/Error, or the
            // override would be invisible.
            var noted = outcomes.Count(o => o.Kind == DragMoveOutcomeKind.Relocated && o.Note != null);

            var summary = (skipped, failed) switch
            {
                (0, 0) => $"{verbPast} {relocated} photo{(relocated == 1 ? "" : "s")}.",
                _ => $"{verbPast} {relocated} of {outcomes.Count} photos."
                     + (skipped > 0 ? $" {skipped} skipped." : string.Empty)
                     + (failed > 0 ? $" {failed} failed." : string.Empty),
            };
            AnnounceRename(summary);

            if (failed == 0 && skipped == 0 && noted == 0)
                return; // no dialog for the common all-success, nothing-to-explain case

            var detail = new StackPanel { Spacing = 6 };
            foreach (var outcome in outcomes.Where(o => o.Kind != DragMoveOutcomeKind.Relocated || o.Note != null))
            {
                var text = outcome.Kind == DragMoveOutcomeKind.Relocated
                    ? $"{outcome.FileName ?? "(unknown)"}: {outcome.Note}"
                    : $"{outcome.FileName ?? "(unknown)"}: {outcome.Error ?? "unknown error"}";
                detail.Children.Add(new TextBlock { Text = text, FontSize = 12, TextWrapping = TextWrapping.Wrap });
            }
            var reportDialog = new ContentDialog
            {
                Title = $"{verbPast} — {summary}",
                Content = new ScrollViewer { Content = detail, MaxHeight = 320 },
                CloseButtonText = "OK",
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            await reportDialog.ShowAsync();
        }

        /// <summary>Skip / Replace / Keep Both, shown only when
        /// RunDragMoveAsync's pre-scan found at least one real collision.
        /// ContentDialog's three button slots (Primary/Secondary/Close) map
        /// 1:1 onto the three choices, with Skip in the Close slot — Escape
        /// or the system dismiss activates the Close button in WinUI by
        /// definition, so an Escape press is equivalent to explicitly
        /// clicking Skip, not a separate "cancel the whole operation" path.
        /// Skip is deliberately the least destructive of the three (colliding
        /// items are left untouched; everything else in the batch still
        /// relocates), which is what makes it the safe implicit choice for a
        /// dismissed dialog.</summary>
        private async Task<DragMoveCollisionChoice> ShowCollisionDialogAsync(int collisionCount)
        {
            var dialog = new ContentDialog
            {
                Title = "Some photos already exist there",
                Content = new TextBlock
                {
                    Text = collisionCount == 1
                        ? "1 photo already has a file with that name in the destination folder."
                        : $"{collisionCount} photos already have a file with that name in the destination folder.",
                    TextWrapping = TextWrapping.Wrap,
                },
                PrimaryButtonText = "Keep Both",
                SecondaryButtonText = "Replace",
                CloseButtonText = "Skip",
                DefaultButton = ContentDialogButton.Primary,
                XamlRoot = (this.Content as FrameworkElement)?.XamlRoot,
            };
            var result = await dialog.ShowAsync();
            return result switch
            {
                ContentDialogResult.Primary => DragMoveCollisionChoice.KeepBoth,
                ContentDialogResult.Secondary => DragMoveCollisionChoice.Replace,
                ContentDialogResult.None => DragMoveCollisionChoice.Skip,
                _ => DragMoveCollisionChoice.Skip,
            };
        }
    }
}
