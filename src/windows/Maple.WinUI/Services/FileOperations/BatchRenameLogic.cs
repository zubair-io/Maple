// BatchRenameLogic.cs — pure preview + sequential-apply orchestration for
// the batch-rename dialog (#2642). See docs/superpowers/specs/2026-08-04-
// file-management-design.md § "Rename": applied SEQUENTIALLY, in
// caller-supplied order, because a shared-destination template can collide
// with itself mid-batch (not only with a pre-existing file) — awaiting each
// LocalFileOperations.RelocateAsync call before starting the next lets that
// call's own collision policy see the PREVIOUS step's real on-disk result,
// exactly the contract src/api/src/library/batch-rename.ts documents
// (`Promise.all`/concurrent application is deliberately never used there,
// and not here either). Mirrors that module's preview/apply split:
// `previewBatchRename` -> BuildPreview (no I/O, self-collision `duplicate`
// flag only), `batchRenameAssets` -> ApplySequentialAsync (real
// LocalFileOperations.RelocateAsync calls, partial-failure per item, never
// rolled back).
//
// The template-render step is injected via RenderFilenameTemplateFunc
// rather than calling Native/RawFfi.cs directly — see BatchRenameTypes.cs's
// header comment for why.

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.FileOperations
{
    public static class BatchRenameLogic
    {
        /// <summary>Windows' classic MAX_PATH limit. The shared raw-core
        /// engine validates the RENDERED FILENAME's own rules (empty, path
        /// separator, leading dot, trailing dot/space, reserved device
        /// name) but has no notion of a destination directory, so it can't
        /// check total path length — that check belongs here, where the
        /// destination directory is known. This is what lets the ticket's
        /// acceptance criteria ("MAX_PATH violations are caught in the
        /// preview … rather than failing at apply time") hold.</summary>
        public const int WindowsMaxPath = 260;

        /// <summary>Render every item's new name against <paramref
        /// name="template"/>, without touching the filesystem — the dialog's
        /// live preview list. Each item's <paramref name="sequenceIndex"/>
        /// (its position in <paramref name="items"/>) matches
        /// ApplySequentialAsync's own indexing, so preview and apply always
        /// agree on what a given template produces.</summary>
        public static IReadOnlyList<BatchRenamePreviewRow> BuildPreview(
            IReadOnlyList<BatchRenameSourceItem> items,
            string template,
            ulong sequenceStart,
            int sequencePadWidth,
            RenderFilenameTemplateFunc render)
        {
            var rows = new List<BatchRenamePreviewRow>(items.Count);
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            for (var i = 0; i < items.Count; i++)
            {
                var item = items[i];
                var rendered = render(
                    template, item.OriginalStem, item.Ext, item.CapturedAtWire,
                    sequenceStart, (ulong)i, sequencePadWidth);
                rows.Add(BuildRow(item, rendered, seen));
            }
            return rows;
        }

        private static BatchRenamePreviewRow BuildRow(
            BatchRenameSourceItem item, FilenameRenderOutcome rendered, HashSet<string> seenInBatch)
        {
            if (!rendered.Ok)
            {
                return new BatchRenamePreviewRow(
                    item.Key, item.CurrentFileName, null,
                    rendered.Error ?? "Template rendering failed.", false, false);
            }

            var newName = rendered.Name!;
            var extensionChanged = RenameLogic.ExtensionChanged(item.CurrentFileName, newName);
            var pathLengthError = MaxPathError(item.Directory, newName);
            if (pathLengthError != null)
                return new BatchRenamePreviewRow(
                    item.Key, item.CurrentFileName, newName, pathLengthError, false, extensionChanged);

            var duplicate = !seenInBatch.Add(DuplicateKey(item.Directory, newName));
            return new BatchRenamePreviewRow(
                item.Key, item.CurrentFileName, newName,
                duplicate
                    ? "Same result as another file in this batch — add a distinguishing token (e.g. {n})."
                    : null,
                duplicate, extensionChanged);
        }

        /// <summary>Render + relocate every item, sequentially, awaiting
        /// each <see cref="LocalFileOperations.RelocateAsync"/> call before
        /// starting the next. One item's failure is recorded per-item and
        /// does NOT stop the remaining items from being attempted — matches
        /// `src/api/src/library/batch-rename.ts`'s `batchRenameAssets`
        /// contract. <paramref name="onItemDone"/>, if given, is invoked
        /// after each item completes with (items completed so far, total)
        /// — the dialog's progress readout for a large or slow (SMB)
        /// batch.</summary>
        public static async Task<IReadOnlyList<BatchRenameItemOutcome>> ApplySequentialAsync(
            IReadOnlyList<BatchRenameSourceItem> items,
            string template,
            ulong sequenceStart,
            int sequencePadWidth,
            CollisionPolicy collision,
            RenderFilenameTemplateFunc render,
            Action<int, int>? onItemDone = null)
        {
            var outcomes = new List<BatchRenameItemOutcome>(items.Count);
            for (var i = 0; i < items.Count; i++)
            {
                var item = items[i];
                outcomes.Add(await ApplyOneAsync(
                    item, template, sequenceStart, (ulong)i, sequencePadWidth, collision, render)
                    .ConfigureAwait(false));
                onItemDone?.Invoke(i + 1, items.Count);
            }
            return outcomes;
        }

        private static async Task<BatchRenameItemOutcome> ApplyOneAsync(
            BatchRenameSourceItem item, string template, ulong sequenceStart, ulong sequenceIndex,
            int sequencePadWidth, CollisionPolicy collision, RenderFilenameTemplateFunc render)
        {
            var rendered = render(
                template, item.OriginalStem, item.Ext, item.CapturedAtWire,
                sequenceStart, sequenceIndex, sequencePadWidth);
            if (!rendered.Ok)
                return new BatchRenameItemOutcome(item.Key, BatchRenameOutcomeKind.Invalid,
                    item.CurrentFileName, Error: rendered.Error ?? "Template rendering failed.");

            var newName = rendered.Name!;
            var pathLengthError = MaxPathError(item.Directory, newName);
            if (pathLengthError != null)
                return new BatchRenameItemOutcome(item.Key, BatchRenameOutcomeKind.Invalid,
                    item.CurrentFileName, Error: pathLengthError);

            if (string.Equals(item.CurrentFileName, newName, StringComparison.Ordinal))
            {
                // Identical name: nothing to do. Reported as a successful
                // no-op rather than routed into RelocateAsync, which would
                // reject an identical source/target as
                // FileOperationErrorKind.SameFile.
                return new BatchRenameItemOutcome(item.Key, BatchRenameOutcomeKind.Relocated,
                    item.CurrentFileName, newName, item.CurrentPath, false, false);
            }

            try
            {
                var outcome = await LocalFileOperations
                    .RelocateAsync(item.CurrentPath, item.Directory, newName, RelocateMode.Move, collision)
                    .ConfigureAwait(false);
                var appliedName = Path.GetFileName(outcome.PrimaryPath);
                return new BatchRenameItemOutcome(item.Key, BatchRenameOutcomeKind.Relocated,
                    item.CurrentFileName, appliedName, outcome.PrimaryPath, outcome.RenamedDueToCollision,
                    RenameLogic.ExtensionChanged(item.CurrentFileName, appliedName));
            }
            catch (FileOperationException ex)
            {
                return new BatchRenameItemOutcome(item.Key, BatchRenameOutcomeKind.Error,
                    item.CurrentFileName, Error: ex.Message);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                return new BatchRenameItemOutcome(item.Key, BatchRenameOutcomeKind.Error,
                    item.CurrentFileName, Error: ex.Message);
            }
        }

        private static string? MaxPathError(string directory, string newName)
        {
            var length = Path.Combine(directory, newName).Length;
            return length > WindowsMaxPath
                ? $"Resulting path is {length} characters — over the Windows {WindowsMaxPath}-character "
                  + "(MAX_PATH) limit."
                : null;
        }

        private static string DuplicateKey(string directory, string newName) =>
            directory.ToUpperInvariant() + "|" + newName.ToUpperInvariant();
    }
}
