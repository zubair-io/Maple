// EditSessionViewModel.Rename.cs — inline single-asset rename (#2639).
// Routes through the same Windows file-operations service #2632 shipped
// (LocalFileOperations.RelocateAsync — a same-directory relocate IS a
// rename), which already carries the case-only-rename classification,
// same-file guard, and sidecar follow this ticket's acceptance criteria
// call out; there is no new file-op logic here, only UI orchestration.
// Name validation goes through the shared raw-core engine
// (Services/FilenameValidation.cs → maple_validate_filename) rather than a
// hand-rolled rule set, per the design doc.
//
// The rename TARGET follows the same "sole selection, else the resolved
// primary target" rule Enter/double-tap already use for opening a photo
// (SelectionLogic.ResolvePrimaryTarget, #2634) — F2/double-click-the-
// filename reuses it rather than inventing a second rule, matching this
// ticket's explicit instruction. Multi-select batch rename is #2642, not
// this ticket.

using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services;
using Maple.WinUI.Services.FileOperations;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        /// <summary>The photo an F2 press or a filename double-click should
        /// rename: the sole selection, else the resolved primary target
        /// (SelectionLogic.ResolvePrimaryTarget) — null when there is no
        /// well-defined single target (empty library, nothing ever
        /// selected).</summary>
        public PhotoItem? ResolveRenameTarget() =>
            ResolvePrimaryTarget(SelectedPhotos, SelectedPhoto, AllPhotos);

        /// <summary>Enters inline-rename UI state for <paramref
        /// name="photo"/>: seeds the edit field with the current filename
        /// and clears any stale error. Re-entrant no-op if already
        /// renaming.</summary>
        public void BeginRename(PhotoItem photo)
        {
            if (photo.IsRenaming)
                return;
            photo.RenameText = photo.FileName;
            photo.RenameError = null;
            photo.IsRenaming = true;
        }

        /// <summary>Escape: discard the edit, leave the file untouched.</summary>
        public void CancelRename(PhotoItem photo)
        {
            photo.IsRenaming = false;
            photo.RenameError = null;
        }

        /// <summary>
        /// Enter: validate and commit <paramref name="photo"/>.RenameText.
        /// Returns true when the field should close — either the rename
        /// succeeded, or the typed text was a no-op (unchanged / blank,
        /// treated as "nothing to do" rather than an error). Returns false
        /// when the name was rejected; RenameError is left set so the
        /// caller can surface it right next to the field and the field
        /// stays open for correction.
        /// </summary>
        public async Task<bool> CommitRenameAsync(PhotoItem photo)
        {
            var typed = photo.RenameText ?? string.Empty;
            if (typed.Trim().Length == 0)
            {
                photo.IsRenaming = false;
                photo.RenameError = null;
                return true;
            }
            if (RenameLogic.IsNoopRename(photo.FileName, typed))
            {
                photo.IsRenaming = false;
                photo.RenameError = null;
                return true;
            }

            var newName = typed.Trim();

            if (photo.IsCloud)
            {
                photo.RenameError = "Cloud photos can't be renamed here yet — rename them from the source library.";
                return false;
            }

            var validationError = FilenameValidation.ValidationError(newName);
            if (validationError != null)
            {
                photo.RenameError = validationError;
                return false;
            }

            var directory = Path.GetDirectoryName(photo.FilePath) ?? string.Empty;
            RelocateOutcome outcome;
            try
            {
                // .Fail, not .AutoSuffix: a manual single rename that types a
                // name already in use should be told so in plain language
                // (this ticket's acceptance criteria), not silently
                // redirected to a name the user never asked for.
                outcome = await LocalFileOperations
                    .RelocateAsync(photo.FilePath, directory, newName, RelocateMode.Move, CollisionPolicy.Fail);
            }
            catch (FileOperationException ex)
            {
                photo.RenameError = ex.Message;
                return false;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                photo.RenameError = ex.Message;
                return false;
            }

            ApplyRenameOutcome(photo, outcome.PrimaryPath);
            photo.IsRenaming = false;
            photo.RenameError = null;
            return true;
        }

        /// <summary>Re-point every path-derived bit of UI state at the
        /// renamed file: FilePath/FileName (drives every {Binding FileName}
        /// / {Binding FilePath} in the grid, Preview/Edit top bars, and the
        /// Info flyout), plus the thumbnail and embedded-preview caches —
        /// the shared grid thumb is keyed on basename
        /// (ThumbCachePaths.SharedThumbPathFor) and the local preview tier
        /// on path+mtime, so leaving the old ThumbnailPath/PreviewPath in
        /// place would keep pointing at cache entries keyed to a name that
        /// no longer names this file. (The OLD name's shared entry was
        /// already reclaimed by LocalFileOperations.FinalizeRelocate —
        /// #2710/#3083.) The decoded scene-linear buffer (if this photo is
        /// open in Edit) does NOT need to change: the rename didn't touch
        /// the pixels, only the name. Takes the bare new path (not a
        /// RelocateOutcome) so the batch-rename apply path
        /// (EditSessionViewModel.BatchRename.cs, #2642) can reuse this same
        /// cache-invalidation logic for every item it relocates.</summary>
        private void ApplyRenameOutcome(PhotoItem photo, string newPrimaryPath)
        {
            photo.FilePath = newPrimaryPath;
            photo.FileName = Path.GetFileName(newPrimaryPath);
            photo.ThumbnailPath = null;
            photo.PreviewPath = null;
            _ = RefreshRenamedThumbnailAsync(photo);
            if (ReferenceEquals(_openPhoto, photo))
                RequestEmbeddedPreview(photo);
        }

        private async Task RefreshRenamedThumbnailAsync(PhotoItem photo)
        {
            var thumb = await _thumbnails.GetOrCreateAsync(photo.FilePath, CancellationToken.None)
                .ConfigureAwait(false);
            var effectiveThumb = thumb
                ?? (photo.Format is "JPG" or "JPEG" ? photo.FilePath : null);
            if (effectiveThumb == null)
                return;
            var uri = new Uri(effectiveThumb).AbsoluteUri;
            OnUi(() => photo.ThumbnailPath = uri);
        }
    }
}
