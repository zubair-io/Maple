// EditSessionViewModel.DragMove.cs — orchestration for dragging assets onto
// the sources tree (#2648): builds DragMoveLogic's pure inputs from the
// current grid selection, pre-scans for collisions, applies sequentially via
// DragMoveLogic.ApplySequentialAsync — the SAME LocalFileOperations relocate
// primitive (#2632) EditSessionViewModel.Rename.cs / .BatchRename.cs already
// use, not a second file-op path — and re-points every successfully-MOVED
// PhotoItem the same way ApplyRenameOutcome already does (FilePath/FileName
// + thumbnail/preview cache invalidation). A successful COPY leaves the
// source PhotoItem untouched: the new duplicate at the destination isn't
// added to this session's in-memory grid — it surfaces the same way any
// other file dropped into a watched folder would, on the next folder load —
// no speculative "insert a second PhotoItem" plumbing for a destination
// folder that may not even be the one currently browsed.
//
// Two call sites share this one method: MainWindow.DragDrop.cs (the
// GridView-to-TreeView drag gesture) and MainWindow.MoveToFolder.cs (the
// keyboard/Narrator-accessible "Move to Folder…" dialog) — see
// DragMoveTypes.cs's header comment.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        /// <summary>Local (non-cloud) photos eligible for a drag-move/drag-copy
        /// or "Move to Folder…" — same restriction as batch rename and inline
        /// rename: Cloud assets route through the Self Hosted API, not this
        /// local module.</summary>
        public static IReadOnlyList<PhotoItem> DragMoveEligible(IReadOnlyList<PhotoItem> selection) =>
            selection.Where(p => !p.IsCloud).ToList();

        /// <summary>Builds DragMoveLogic's pure source-item list from
        /// <paramref name="photos"/>, keyed by each photo's CURRENT
        /// FilePath.</summary>
        public static IReadOnlyList<DragMoveSourceItem> BuildDragMoveSources(IReadOnlyList<PhotoItem> photos) =>
            photos.Select(p => new DragMoveSourceItem(
                Key: p.FilePath,
                Directory: Path.GetDirectoryName(p.FilePath) ?? string.Empty,
                CurrentFileName: p.FileName,
                CurrentPath: p.FilePath)).ToList();

        /// <summary>True when at least one of <paramref name="sources"/>
        /// would actually relocate somewhere new if dropped/moved onto
        /// <paramref name="destinationDir"/> — the gate the drop target
        /// (DragOver) and the "Move to Folder…" dialog both consult before
        /// accepting.</summary>
        public static bool DragMoveHasApplicableTarget(
            IReadOnlyList<DragMoveSourceItem> sources, string destinationDir) =>
            DragMoveLogic.HasApplicableItem(sources, destinationDir);

        /// <summary>Real-filesystem collision pre-scan for
        /// <paramref name="sources"/> against <paramref name="destinationDir"/>
        /// — drives whether the Skip/Replace/Keep Both dialog needs to show
        /// at all.</summary>
        public static IReadOnlyList<string> DetectDragMoveCollisions(
            IReadOnlyList<DragMoveSourceItem> sources, string destinationDir) =>
            DragMoveLogic.DetectCollisions(sources, destinationDir,
                path => File.Exists(path) || Directory.Exists(path));

        /// <summary>Applies the drag-move/drag-copy sequentially and
        /// re-points every successfully-relocated (Move mode only) PhotoItem
        /// at its new path. Returns the per-item outcomes as-is; the caller
        /// owns the summary/announcement, same split as
        /// ApplyBatchRenameAsync.</summary>
        public async Task<IReadOnlyList<DragMoveItemOutcome>> ApplyDragMoveAsync(
            IReadOnlyList<PhotoItem> photos,
            IReadOnlyList<DragMoveSourceItem> sources,
            string destinationDir,
            RelocateMode mode,
            IReadOnlyCollection<string> collidingKeys,
            DragMoveCollisionChoice collisionChoice,
            Action<int, int>? onItemDone = null)
        {
            var byKey = photos
                .GroupBy(p => p.FilePath, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(g => g.Key, g => g.First(), StringComparer.OrdinalIgnoreCase);
            var outcomes = await DragMoveLogic.ApplySequentialAsync(
                sources, destinationDir, mode, collidingKeys, collisionChoice, onItemDone)
                .ConfigureAwait(false);

            if (mode == RelocateMode.Move)
            {
                foreach (var outcome in outcomes)
                {
                    if (outcome.Kind != DragMoveOutcomeKind.Relocated) continue;
                    if (outcome.NewPath == null) continue;
                    if (!byKey.TryGetValue(outcome.Key, out var photo)) continue;
                    var newPath = outcome.NewPath;
                    OnUi(() => ApplyRenameOutcome(photo, newPath));
                }
            }
            return outcomes;
        }
    }
}
