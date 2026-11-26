// ExternalRenameBatchTests — batches whose renames depend on each other
// (#6072). A swap or rotation that finishes inside one watcher window has no
// order that settles it, so no sidecar of those renames is touched; renames
// that converge on a sidecar name never overwrite it. Real temp files; every
// sidecar's name and bytes are asserted after the call.

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class ExternalRenameBatchTests : IDisposable
    {
        private readonly string _dir;

        public ExternalRenameBatchTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-external-batch-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        private string P(string name) => Path.Combine(_dir, name);

        private void Write(string name, string content) => File.WriteAllText(P(name), content);

        private (string Old, string New) Explorer(string from, string to)
        {
            File.Move(P(from), P(to));
            return (P(from), P(to));
        }

        private string[] Sidecars() =>
            Directory.EnumerateFiles(_dir, "*.xmp")
                .Select(f => Path.GetFileName(f) + "=" + File.ReadAllText(f))
                .OrderBy(n => n, StringComparer.Ordinal).ToArray();

        private void AssertNoTemporaries() =>
            Assert.Empty(Directory.EnumerateFileSystemEntries(_dir, ".*"));

        private void Swap(string first, string second)
        {
            File.Move(P(first), P("swap.tmp"));
            File.Move(P(second), P(first));
            File.Move(P("swap.tmp"), P(second));
        }

        [Fact]
        public void Swap_WithTwoSidecars_TouchesNoSidecar()
        {
            Write("A.jpg", "pixels-a");
            Write("B.jpg", "pixels-b");
            Write("A.xmp", "<a/>");
            Write("B.xmp", "<b/>");
            Swap("A.jpg", "B.jpg");

            var results = LocalFileOperations.FollowExternalRenames(
                new[] { (P("A.jpg"), P("B.jpg")), (P("B.jpg"), P("A.jpg")) });

            Assert.All(results, r => Assert.Equal(ExternalRenameSidecarOutcome.Skipped, r.Outcome));
            Assert.All(results, r => Assert.True(r.ReadsOtherSidecar));
            Assert.Equal(new[] { "A.xmp=<a/>", "B.xmp=<b/>" }, Sidecars());
            AssertNoTemporaries();
        }

        [Fact]
        public void ThreeWayRotation_TouchesNoSidecar()
        {
            foreach (var n in new[] { "A", "B", "C" })
            {
                Write(n + ".jpg", "pixels-" + n);
                Write(n + ".xmp", "<" + n + "/>");
            }
            File.Move(P("C.jpg"), P("rot.tmp"));
            File.Move(P("B.jpg"), P("C.jpg"));
            File.Move(P("A.jpg"), P("B.jpg"));
            File.Move(P("rot.tmp"), P("A.jpg"));

            var results = LocalFileOperations.FollowExternalRenames(new[]
            {
                (P("A.jpg"), P("B.jpg")), (P("B.jpg"), P("C.jpg")), (P("C.jpg"), P("A.jpg")),
            });

            Assert.All(results, r => Assert.Equal(ExternalRenameSidecarOutcome.Skipped, r.Outcome));
            Assert.Equal(new[] { "A.xmp=<A/>", "B.xmp=<B/>", "C.xmp=<C/>" }, Sidecars());
            AssertNoTemporaries();
        }

        [Fact]
        public void SwapPlusAThirdRenameOntoOneOfItsStems_TouchesNoSidecar()
        {
            Write("A.jpg", "pixels-a");
            Write("B.jpg", "pixels-b");
            Write("C.CR3", "raw-c");
            Write("A.xmp", "<a/>");
            Write("B.xmp", "<b/>");
            Write("C.xmp", "<c/>");
            Swap("A.jpg", "B.jpg");
            var third = Explorer("C.CR3", "A.CR3");

            var results = LocalFileOperations.FollowExternalRenames(new[]
            {
                (P("A.jpg"), P("B.jpg")), (P("B.jpg"), P("A.jpg")), third,
            });

            Assert.All(results, r => Assert.Equal(ExternalRenameSidecarOutcome.Skipped, r.Outcome));
            Assert.Equal(new[] { "A.xmp=<a/>", "B.xmp=<b/>", "C.xmp=<c/>" }, Sidecars());
            AssertNoTemporaries();
        }

        [Fact]
        public void TwoGroupsConvergingOnOneSidecarName_TheLaterOneCollides()
        {
            Write("X.jpg", "x");
            Write("Y.CR3", "y");
            Write("X.xmp", "<x/>");
            Write("Y.xmp", "<y/>");

            var results = LocalFileOperations.FollowExternalRenames(new[]
            {
                Explorer("X.jpg", "Z.jpg"), Explorer("Y.CR3", "Z.CR3"),
            });

            Assert.Equal(ExternalRenameSidecarOutcome.Carried, results[0].Outcome);
            Assert.Equal(ExternalRenameSidecarOutcome.Collision, results[1].Outcome);
            Assert.True(results[1].ReadsOtherSidecar);
            Assert.Equal(new[] { "Y.xmp=<y/>", "Z.xmp=<x/>" }, Sidecars());
        }

        [Fact]
        public void RenumberingOntoAnOccupiedHead_EveryCollisionLeavesEverySidecarWhereItIs()
        {
            foreach (var n in new[] { "2", "3" })
            {
                Write(n + ".CR3", "raw" + n);
                Write(n + ".jpg", "jpg" + n);
                Write(n + ".xmp", "<edits" + n + "/>");
            }
            Write("4.xmp", "<edits4/>");

            var results = LocalFileOperations.FollowExternalRenames(new[]
            {
                Explorer("3.CR3", "4.CR3"),
                Explorer("3.jpg", "4.jpg"),
                Explorer("2.CR3", "3.CR3"),
                Explorer("2.jpg", "3.jpg"),
            });

            Assert.All(results, r => Assert.Equal(ExternalRenameSidecarOutcome.Collision, r.Outcome));
            Assert.All(results, r => Assert.True(r.ReadsOtherSidecar));
            Assert.Equal(new[] { "2.xmp=<edits2/>", "3.xmp=<edits3/>", "4.xmp=<edits4/>" }, Sidecars());
        }

        [Fact]
        public void ABatchOfSeveralHundredRenames_FinishesQuickly()
        {
            const int count = 300;
            for (var i = 0; i < count; i++)
            {
                Write($"IMG_{i:D4}.jpg", "jpg");
                Write($"IMG_{i:D4}.xmp", $"<edits{i}/>");
                if (i % 2 == 0) Write($"IMG_{i:D4}.CR3", "raw");
            }
            var renames = Enumerable.Range(0, count)
                .Select(i => Explorer($"IMG_{i:D4}.jpg", $"Renamed_{i:D4}.jpg")).ToList();

            var clock = Stopwatch.StartNew();
            var results = LocalFileOperations.FollowExternalRenames(renames);
            clock.Stop();

            Assert.True(clock.Elapsed < TimeSpan.FromSeconds(5), $"took {clock.Elapsed}");
            Assert.All(results, r => Assert.Equal(ExternalRenameSidecarOutcome.Carried, r.Outcome));
            Assert.Equal(count, Directory.EnumerateFiles(_dir, "Renamed_*.xmp").Count());
            Assert.Equal(count / 2, Directory.EnumerateFiles(_dir, "IMG_*.xmp").Count());
        }
    }
}
