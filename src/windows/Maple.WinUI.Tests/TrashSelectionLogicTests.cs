// TrashSelectionLogicTests — real temp directories, real files; the
// Recycle Bin itself is faked (see Support/FakeRecycleBinService.cs) for
// the same reason TrashTests.cs fakes it. Covers #2654's multi-select
// Delete apply: destination-kind reporting per item, progress callback
// fan-out, an unresolvable library root reported as a per-item error
// without aborting the rest of the batch, and the pre-flight
// PredictDestinationKind confirmation-dialog helper.

using System;
using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class TrashSelectionLogicTests : IDisposable
    {
        private readonly string _dir;

        public TrashSelectionLogicTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-trash-selection-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        private string WriteFile(string relPath, string content)
        {
            var full = Path.Combine(_dir, relPath);
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(full, content);
            return full;
        }

        [Fact]
        public async Task ApplySequentialAsync_RecycleBinSucceeds_ReportsRecycleBinDestination()
        {
            var raw = WriteFile("photo.dng", "bytes");
            var items = new[] { new TrashSourceItem(raw, raw, "photo.dng") };
            var fake = new FakeRecycleBinService { Succeeds = true };

            var outcomes = await TrashSelectionLogic.ApplySequentialAsync(
                items, _ => _dir, fake);

            var outcome = Assert.Single(outcomes);
            Assert.Equal(TrashOutcomeKind.Trashed, outcome.Kind);
            Assert.Equal(TrashDestinationKind.RecycleBin, outcome.DestinationKind);
        }

        [Fact]
        public async Task ApplySequentialAsync_RecycleBinUnavailable_ReportsMapleTrashFolderDestination()
        {
            var raw = WriteFile("photo.dng", "bytes");
            var items = new[] { new TrashSourceItem(raw, raw, "photo.dng") };
            var fake = new FakeRecycleBinService { Succeeds = false };

            var outcomes = await TrashSelectionLogic.ApplySequentialAsync(
                items, _ => _dir, fake);

            var outcome = Assert.Single(outcomes);
            Assert.Equal(TrashOutcomeKind.Trashed, outcome.Kind);
            Assert.Equal(TrashDestinationKind.MapleTrashFolder, outcome.DestinationKind);
        }

        [Fact]
        public async Task ApplySequentialAsync_NoLibraryRootResolved_ReportsErrorWithoutThrowing()
        {
            var raw = WriteFile("photo.dng", "bytes");
            var items = new[] { new TrashSourceItem(raw, raw, "photo.dng") };

            var outcomes = await TrashSelectionLogic.ApplySequentialAsync(
                items, _ => null, new FakeRecycleBinService { Succeeds = true });

            var outcome = Assert.Single(outcomes);
            Assert.Equal(TrashOutcomeKind.Error, outcome.Kind);
            Assert.NotNull(outcome.Error);
        }

        [Fact]
        public async Task ApplySequentialAsync_OneItemErrors_RestOfBatchStillCompletes()
        {
            // Succeeds = false routes both items through the `.maple/trash`
            // fallback (LocalFileOperations.TrashToMapleFolderAsync ->
            // RelocateAsync -> PlanRelocateAsync), which DOES validate
            // source existence before doing anything — unlike the fake
            // Recycle Bin call, which (like the real SHFileOperationW,
            // whose failure mode this fake models) has no reason to
            // pre-check a path this module never inspects itself.
            var missing = Path.Combine(_dir, "gone.dng"); // never written — SourceMissing
            var present = WriteFile("here.dng", "bytes");
            var items = new[]
            {
                new TrashSourceItem(missing, missing, "gone.dng"),
                new TrashSourceItem(present, present, "here.dng"),
            };
            var fake = new FakeRecycleBinService { Succeeds = false };
            var progress = new List<(int Done, int Total)>();

            var outcomes = await TrashSelectionLogic.ApplySequentialAsync(
                items, _ => _dir, fake, (done, total) => progress.Add((done, total)));

            Assert.Equal(TrashOutcomeKind.Error, outcomes[0].Kind);
            Assert.Equal(TrashOutcomeKind.Trashed, outcomes[1].Kind);
            Assert.Equal(TrashDestinationKind.MapleTrashFolder, outcomes[1].DestinationKind);
            Assert.Equal(new[] { (1, 2), (2, 2) }, progress);
        }

        [Fact]
        public void PredictDestinationKind_LocalFixedDrivePath_PredictsRecycleBin()
        {
            var raw = WriteFile("photo.dng", "bytes");
            Assert.Equal(TrashDestinationKind.RecycleBin, TrashSelectionLogic.PredictDestinationKind(raw));
        }

        [Fact]
        public void PredictDestinationKind_UncPath_PredictsMapleTrashFolder()
        {
            Assert.Equal(
                TrashDestinationKind.MapleTrashFolder,
                TrashSelectionLogic.PredictDestinationKind(@"\\server\share\photo.dng"));
        }
    }
}
