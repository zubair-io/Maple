// RawJpegStackBatchOperationTests — a stacked RAW+JPEG tile through the grid's
// batch flows (#5050, #5848): drag-move / Move to Folder (DragMoveLogic) and
// batch rename (BatchRenameLogic). The tile is one item whose JPEG follows the
// RAW; a collision choice made for the tile never replaces a JPEG. Real temp
// directories, real files.

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RawJpegStackBatchOperationTests : IDisposable
    {
        private readonly string _root;

        public RawJpegStackBatchOperationTests()
        {
            _root = Path.Combine(Path.GetTempPath(), "maple-winui-stack-batch-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(P("src"));
            Directory.CreateDirectory(P("dest"));
        }

        public void Dispose()
        {
            try { Directory.Delete(_root, recursive: true); }
            catch (IOException) { }
        }

        private string P(params string[] parts) => Path.Combine(_root, Path.Combine(parts));

        private string Write(string content, params string[] parts)
        {
            var full = P(parts);
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(full, content);
            return full;
        }

        private string[] Names(string folder) =>
            Directory.EnumerateFiles(P(folder)).Select(Path.GetFileName).OrderBy(n => n, StringComparer.Ordinal).ToArray()!;

        private DragMoveSourceItem DragPair(string folder, string stem)
        {
            var raw = Write("raw " + folder, folder, stem + ".CR3");
            var jpeg = Write("jpeg " + folder, folder, stem + ".JPG");
            Write("<edits " + folder + "/>", folder, stem + ".xmp");
            return new DragMoveSourceItem(raw, P(folder), stem + ".CR3", raw, jpeg);
        }

        private static bool Exists(string path) => File.Exists(path) || Directory.Exists(path);

        [Fact]
        public void TheCollisionPreScan_FlagsATileWhoseJpegNameAloneIsTaken()
        {
            var pair = DragPair("src", "IMG_1");
            var lone = new DragMoveSourceItem("lone", P("src"), "IMG_2.CR3", Write("raw", "src", "IMG_2.CR3"));
            Write("other jpeg", "dest", "IMG_1.JPG");

            var colliding = DragMoveLogic.DetectCollisions(
                new[] { pair, lone }, P("dest"), Exists, LocalFileOperations.SidecarAlreadyCarried);

            Assert.Equal(new[] { pair.Key }, colliding);
        }

        [Fact]
        public async Task Move_RelocatesBothFilesOfTheTile_AndReportsWhereTheJpegLanded()
        {
            var pair = DragPair("src", "IMG_1");

            var outcome = Assert.Single(await DragMoveLogic.ApplySequentialAsync(
                new[] { pair }, P("dest"), RelocateMode.Move, Array.Empty<string>(), DragMoveCollisionChoice.KeepBoth));

            Assert.Equal(DragMoveOutcomeKind.Relocated, outcome.Kind);
            Assert.Equal(P("dest", "IMG_1.CR3"), outcome.NewPath);
            Assert.Equal(P("dest", "IMG_1.JPG"), outcome.CompanionNewPath);
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" }, Names("dest"));
            Assert.Empty(Names("src"));
        }

        [Fact]
        public async Task Skip_LeavesBothFilesOfACollidingTile()
        {
            var pair = DragPair("src", "IMG_1");
            Write("other jpeg", "dest", "IMG_1.JPG");

            var outcome = Assert.Single(await DragMoveLogic.ApplySequentialAsync(
                new[] { pair }, P("dest"), RelocateMode.Move, new[] { pair.Key }, DragMoveCollisionChoice.Skip));

            Assert.Equal(DragMoveOutcomeKind.Skipped, outcome.Kind);
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" }, Names("src"));
            Assert.Equal(new[] { "IMG_1.JPG" }, Names("dest"));
        }

        [Fact]
        public async Task Replace_OnTheTile_NeverReplacesAJpeg_ThePairStaysAndTheJpegIsNamed()
        {
            var pair = DragPair("src", "IMG_1");
            Write("other raw", "dest", "IMG_1.CR3");
            Write("other jpeg", "dest", "IMG_1.JPG");

            var outcome = Assert.Single(await DragMoveLogic.ApplySequentialAsync(
                new[] { pair }, P("dest"), RelocateMode.Move, new[] { pair.Key }, DragMoveCollisionChoice.Replace));

            Assert.Equal(DragMoveOutcomeKind.Error, outcome.Kind);
            Assert.Contains("IMG_1.JPG", outcome.Error);
            Assert.Equal("other raw", File.ReadAllText(P("dest", "IMG_1.CR3")));
            Assert.Equal("other jpeg", File.ReadAllText(P("dest", "IMG_1.JPG")));
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" }, Names("src"));
        }

        [Fact]
        public async Task KeepBoth_MovesAJpegOnlyCollisionToOneFreeStem()
        {
            var pair = DragPair("src", "IMG_1");
            Write("other jpeg", "dest", "IMG_1.JPG");

            var outcome = Assert.Single(await DragMoveLogic.ApplySequentialAsync(
                new[] { pair }, P("dest"), RelocateMode.Move, new[] { pair.Key }, DragMoveCollisionChoice.KeepBoth));

            Assert.Equal(P("dest", "IMG_1.1.CR3"), outcome.NewPath);
            Assert.Equal(P("dest", "IMG_1.1.JPG"), outcome.CompanionNewPath);
            Assert.Equal("other jpeg", File.ReadAllText(P("dest", "IMG_1.JPG")));
        }

        [Fact]
        public async Task TwoSameNamedTilesInOneDrop_TheSecondPairIsSuffixedNotOverwritten()
        {
            var first = DragPair("src", "IMG_1");
            var second = DragPair("other", "IMG_1");

            var outcomes = await DragMoveLogic.ApplySequentialAsync(
                new[] { first, second }, P("dest"), RelocateMode.Move,
                Array.Empty<string>(), DragMoveCollisionChoice.Replace);

            Assert.All(outcomes, o => Assert.Equal(DragMoveOutcomeKind.Relocated, o.Kind));
            Assert.Equal(P("dest", "IMG_1.1.JPG"), outcomes[1].CompanionNewPath);
            Assert.NotNull(outcomes[1].Note);
            Assert.Equal(
                new[] { "IMG_1.1.CR3", "IMG_1.1.JPG", "IMG_1.1.xmp", "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" },
                Names("dest"));
            Assert.Equal("jpeg src", File.ReadAllText(P("dest", "IMG_1.JPG")));
            Assert.Equal("jpeg other", File.ReadAllText(P("dest", "IMG_1.1.JPG")));
        }

        private static FilenameRenderOutcome Render(
            string template, string stem, string ext, string? capturedAt,
            ulong sequenceStart, ulong sequenceIndex, int sequencePadWidth) =>
            FilenameRenderOutcome.Success(template
                .Replace("{original}", stem)
                .Replace("{n}", (sequenceStart + sequenceIndex).ToString())
                .Replace("{ext}", ext));

        private BatchRenameSourceItem RenamePair(string stem, string rawExt)
        {
            var raw = Write("raw " + stem, "src", stem + "." + rawExt);
            var jpeg = Write("jpeg " + stem, "src", stem + ".JPG");
            Write("<edits " + stem + "/>", "src", stem + ".xmp");
            return new BatchRenameSourceItem(raw, P("src"), stem + "." + rawExt, raw, stem, rawExt, null, jpeg);
        }

        [Fact]
        public async Task BatchRename_RenamesEachJpegToItsRawsNewStem()
        {
            var items = new[] { RenamePair("IMG_1", "CR3"), RenamePair("IMG_2", "CR3") };

            var outcomes = await BatchRenameLogic.ApplySequentialAsync(
                items, "Trip-{n}.{ext}", 1, 0, CollisionPolicy.AutoSuffix, Render);

            Assert.All(outcomes, o => Assert.Equal(BatchRenameOutcomeKind.Relocated, o.Kind));
            Assert.Equal(P("src", "Trip-1.JPG"), outcomes[0].CompanionNewPath);
            Assert.Equal(P("src", "Trip-2.JPG"), outcomes[1].CompanionNewPath);
            Assert.Equal(
                new[] { "Trip-1.CR3", "Trip-1.JPG", "Trip-1.xmp", "Trip-2.CR3", "Trip-2.JPG", "Trip-2.xmp" },
                Names("src"));
            Assert.Equal("jpeg IMG_2", File.ReadAllText(P("src", "Trip-2.JPG")));
            Assert.Equal("<edits IMG_2/>", File.ReadAllText(P("src", "Trip-2.xmp")));
        }

        [Theory]
        [InlineData(CollisionPolicy.Fail)]
        [InlineData(CollisionPolicy.Replace)]
        public async Task BatchRename_ATakenJpegName_SkipsThePairWhateverThePolicy(CollisionPolicy policy)
        {
            var item = RenamePair("IMG_1", "CR3");
            Write("someone else's jpeg", "src", "Trip.JPG");

            var outcome = Assert.Single(await BatchRenameLogic.ApplySequentialAsync(
                new[] { item }, "Trip.{ext}", 1, 0, policy, Render));

            Assert.Equal(BatchRenameOutcomeKind.Error, outcome.Kind);
            Assert.Contains("Trip.JPG", outcome.Error);
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp", "Trip.JPG" }, Names("src"));
            Assert.Equal("someone else's jpeg", File.ReadAllText(P("src", "Trip.JPG")));
        }

        [Fact]
        public async Task BatchRename_TwoPairsWhoseJpegsWouldShareAName_KeepsBothJpegs()
        {
            var items = new[] { RenamePair("IMG_1", "CR3"), RenamePair("IMG_2", "NEF") };

            var outcomes = await BatchRenameLogic.ApplySequentialAsync(
                items, "Trip.{ext}", 1, 0, CollisionPolicy.AutoSuffix, Render);

            Assert.All(outcomes, o => Assert.Equal(BatchRenameOutcomeKind.Relocated, o.Kind));
            Assert.Equal(
                new[] { "Trip.1.JPG", "Trip.1.NEF", "Trip.1.xmp", "Trip.CR3", "Trip.JPG", "Trip.xmp" },
                Names("src"));
            Assert.Equal("jpeg IMG_1", File.ReadAllText(P("src", "Trip.JPG")));
            Assert.Equal("jpeg IMG_2", File.ReadAllText(P("src", "Trip.1.JPG")));
        }
    }
}
