// RawJpegBatchRenamePreviewTests — the batch-rename preview evaluates a
// stacked tile's JPEG destination with the same checks as the RAW's (#5848),
// so a taken name, a repeated name or an over-long path shows on the tile's
// row instead of only failing at apply. Real temp directory for the
// existing-file check.

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RawJpegBatchRenamePreviewTests : IDisposable
    {
        private readonly string _dir;

        public RawJpegBatchRenamePreviewTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-stack-preview-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        private static FilenameRenderOutcome Render(
            string template, string stem, string ext, string? capturedAt,
            ulong sequenceStart, ulong sequenceIndex, int sequencePadWidth) =>
            FilenameRenderOutcome.Success(template
                .Replace("{original}", stem)
                .Replace("{n}", (sequenceStart + sequenceIndex).ToString())
                .Replace("{ext}", ext));

        private static bool Exists(string path) => File.Exists(path) || Directory.Exists(path);

        private BatchRenameSourceItem Pair(string stem, string rawExt, string jpegExt = "JPG", string? directory = null)
        {
            var dir = directory ?? _dir;
            var raw = Path.Combine(dir, stem + "." + rawExt);
            var jpeg = Path.Combine(dir, stem + "." + jpegExt);
            return new BatchRenameSourceItem(raw, dir, stem + "." + rawExt, raw, stem, rawExt, null, jpeg);
        }

        [Fact]
        public void ATakenJpegName_ShowsOnTheTilesRow_WhileTheRowStillApplies()
        {
            File.WriteAllText(Path.Combine(_dir, "Trip.JPG"), "someone else's");

            var row = Assert.Single(BatchRenameLogic.BuildPreview(
                new[] { Pair("IMG_1", "CR3") }, "Trip.{ext}", 0, 0, Render, Exists));

            Assert.Equal("Trip.CR3", row.NewFileName);
            Assert.Contains("Trip.JPG", row.CompanionNote);
            Assert.True(row.WouldApply);
        }

        [Fact]
        public void AJpegNameTheTileAlreadyHolds_IsNotATakenName()
        {
            var row = Assert.Single(BatchRenameLogic.BuildPreview(
                new[] { Pair("IMG_1", "CR3") }, "{original}.{ext}", 0, 0, Render, Exists));

            Assert.Null(row.CompanionNote);
        }

        [Fact]
        public void AJpegNameAnotherTileInTheBatchIsLeaving_IsNotATakenName()
        {
            var first = Pair("IMG_1", "CR3");
            var second = Pair("IMG_2", "CR3");
            File.WriteAllText(first.CompanionPath!, "jpeg");
            File.WriteAllText(second.CompanionPath!, "jpeg");

            var rows = BatchRenameLogic.BuildPreview(
                new[] { first, second }, "IMG_{n}.{ext}", 2, 0, Render, Exists);

            Assert.All(rows, row => Assert.Null(row.CompanionNote));
        }

        [Fact]
        public void TwoTilesWhoseJpegsWouldShareAName_FlagTheSecondRowAsADuplicate()
        {
            var rows = BatchRenameLogic.BuildPreview(
                new[] { Pair("IMG_1", "CR3"), Pair("IMG_2", "NEF") }, "Trip.{ext}", 0, 0, Render, Exists);

            Assert.False(rows[0].IsDuplicateWithinBatch);
            Assert.True(rows[1].IsDuplicateWithinBatch);
            Assert.Contains("Trip.JPG", rows[1].CompanionNote);
            Assert.True(rows[1].WouldApply);
        }

        [Fact]
        public void AJpegPathPastMaxPath_IsAnErrorOnTheRow_EvenWhenTheRawPathFits()
        {
            var overhead = Path.Combine(_dir, "T.ARW").Length;
            var stem = new string('a', BatchRenameLogic.WindowsMaxPath - overhead + 1);
            var item = Pair("IMG_1", "ARW", "JPEG");
            Assert.Equal(BatchRenameLogic.WindowsMaxPath, Path.Combine(_dir, stem + ".ARW").Length);

            var row = Assert.Single(BatchRenameLogic.BuildPreview(
                new[] { item }, stem + ".{ext}", 0, 0, Render, Exists));

            Assert.False(row.WouldApply);
            Assert.Contains("JPEG", row.Error);
            Assert.Equal(stem + ".ARW", row.NewFileName);
        }

        [Fact]
        public async Task AJpegPathPastMaxPath_IsRefusedAtApplyBeforeAnyFileMoves()
        {
            var overhead = Path.Combine(_dir, "T.ARW").Length;
            var stem = new string('a', BatchRenameLogic.WindowsMaxPath - overhead + 1);
            var item = Pair("IMG_1", "ARW", "JPEG");
            File.WriteAllText(item.CurrentPath, "raw");
            File.WriteAllText(item.CompanionPath!, "jpeg");

            var outcome = Assert.Single(await BatchRenameLogic.ApplySequentialAsync(
                new[] { item }, stem + ".{ext}", 0, 0, CollisionPolicy.Fail, Render));

            Assert.Equal(BatchRenameOutcomeKind.Invalid, outcome.Kind);
            Assert.True(File.Exists(item.CurrentPath));
            Assert.True(File.Exists(item.CompanionPath!));
        }

        [Fact]
        public void WithoutAnExistenceCheck_TheNoIoPreviewStaysSilentAboutTakenNames()
        {
            File.WriteAllText(Path.Combine(_dir, "Trip.JPG"), "someone else's");

            var row = Assert.Single(BatchRenameLogic.BuildPreview(
                new[] { Pair("IMG_1", "CR3") }, "Trip.{ext}", 0, 0, Render));

            Assert.Null(row.CompanionNote);
        }
    }
}
