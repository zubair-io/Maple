// EditSessionViewModel.BatchRename.cs — batch-rename dialog orchestration
// (#2642): builds BatchRenameLogic's pure inputs from the current grid
// multi-selection, renders the live preview through the shared raw-core
// engine (Services/FilenameTemplateEngine.cs), and applies sequentially via
// BatchRenameLogic.ApplySequentialAsync — the SAME LocalFileOperations
// relocate primitive (#2632) and same-directory-relocate-is-a-rename shape
// the inline single rename (#2639, EditSessionViewModel.Rename.cs) already
// uses, not a second file-op path. On a successful relocate, this re-points
// the PhotoItem the same way ApplyRenameOutcome already does for a single
// rename (FilePath/FileName + thumbnail/preview cache invalidation) — see
// that method's own doc comment for why the decoded scene-linear buffer
// doesn't need to change.
//
// MainWindow.BatchRename.cs (the ContentDialog, template field, live
// preview ListView, Narrator announcements) is the only consumer of this
// file — kept separate the same way MainWindow.Rename.cs /
// EditSessionViewModel.Rename.cs split UI-thread mechanics from
// validation/relocate orchestration.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services;
using Maple.WinUI.Services.FileOperations;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        /// <summary>Local (non-cloud) photos eligible for the batch-rename
        /// dialog, in the order the caller (the grid's current selection)
        /// supplied them — the same order that becomes each item's `{n}`
        /// index. Cloud assets are filtered out; batch rename, like inline
        /// rename, only reaches local Filesystem/SMB sources today (see
        /// EditSessionViewModel.Rename.cs's CommitRenameAsync).</summary>
        public static IReadOnlyList<PhotoItem> BatchRenameEligible(IReadOnlyList<PhotoItem> selection) =>
            selection.Where(p => !p.IsCloud).ToList();

        /// <summary>Builds BatchRenameLogic's pure source-item list from
        /// <paramref name="photos"/>, keyed by each photo's CURRENT
        /// FilePath — stable for the lifetime of one dialog session, since
        /// the key is captured before any rename in the batch runs.</summary>
        public static IReadOnlyList<BatchRenameSourceItem> BuildBatchRenameSources(
            IReadOnlyList<PhotoItem> photos) =>
            photos.Select(p =>
            {
                var (stem, ext) = SplitStemExt(p.FileName);
                return new BatchRenameSourceItem(
                    Key: p.FilePath,
                    Directory: Path.GetDirectoryName(p.FilePath) ?? string.Empty,
                    CurrentFileName: p.FileName,
                    CurrentPath: p.FilePath,
                    OriginalStem: stem,
                    Ext: ext,
                    CapturedAtWire: ExifWireFormat(p.CaptureDate));
            }).ToList();

        /// <summary>Live before/after preview for the batch-rename dialog —
        /// no filesystem writes.</summary>
        public static IReadOnlyList<BatchRenamePreviewRow> BuildBatchRenamePreview(
            IReadOnlyList<BatchRenameSourceItem> sources,
            string template,
            ulong sequenceStart,
            int sequencePadWidth) =>
            BatchRenameLogic.BuildPreview(
                sources, template, sequenceStart, sequencePadWidth, FilenameTemplateEngine.Render);

        /// <summary>Applies the batch sequentially and re-points every
        /// successfully-relocated PhotoItem at its new path (FilePath,
        /// FileName, thumbnail/preview cache invalidation — see
        /// ApplyRenameOutcome). Returns the per-item outcomes as-is; this
        /// method does not decide what "success" means to the user, only
        /// what it means to the filesystem — MainWindow.BatchRename.cs owns
        /// the summary/announcement.</summary>
        public async Task<IReadOnlyList<BatchRenameItemOutcome>> ApplyBatchRenameAsync(
            IReadOnlyList<PhotoItem> photos,
            IReadOnlyList<BatchRenameSourceItem> sources,
            string template,
            ulong sequenceStart,
            int sequencePadWidth,
            CollisionPolicy collision,
            Action<int, int>? onItemDone = null)
        {
            var byKey = photos.ToDictionary(p => p.FilePath, p => p, StringComparer.OrdinalIgnoreCase);
            var outcomes = await BatchRenameLogic.ApplySequentialAsync(
                sources, template, sequenceStart, sequencePadWidth, collision,
                FilenameTemplateEngine.Render, onItemDone)
                .ConfigureAwait(false);

            foreach (var outcome in outcomes)
            {
                if (outcome.Kind != BatchRenameOutcomeKind.Relocated) continue;
                if (outcome.NewPath == null) continue;
                if (!byKey.TryGetValue(outcome.Key, out var photo)) continue;
                if (string.Equals(photo.FilePath, outcome.NewPath, StringComparison.Ordinal)) continue;
                var newPath = outcome.NewPath;
                OnUi(() => ApplyRenameOutcome(photo, newPath));
            }
            return outcomes;
        }

        private static (string Stem, string Ext) SplitStemExt(string fileName)
        {
            var stem = Path.GetFileNameWithoutExtension(fileName);
            var ext = Path.GetExtension(fileName);
            return (stem, ext.StartsWith('.') ? ext[1..] : ext);
        }

        /// <summary>Converts a PhotoItem's parsed capture date to EXIF
        /// `DateTimeOriginal`'s `"YYYY:MM:DD HH:MM:SS"` wire format — the
        /// shape `{date:FORMAT}` expects (raw_core::filename::date). Null
        /// when the photo has no parsed capture date; the engine then
        /// renders every `{date:FORMAT}` token as its documented fallback
        /// text instead of failing.</summary>
        private static string? ExifWireFormat(DateTime? captureDate) =>
            captureDate is { } dt
                ? $"{dt.Year:D4}:{dt.Month:D2}:{dt.Day:D2} {dt.Hour:D2}:{dt.Minute:D2}:{dt.Second:D2}"
                : null;
    }
}
