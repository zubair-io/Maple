// ExternalRenameSidecarTests — a photo renamed in File Explorer while its
// folder is open (#6072). The shared-sidecar rule (docs/xmp-canonical-format.md
// § "Moving, renaming and trashing a photo") must hold: IMG.CR3 and IMG.jpg
// both read IMG.xmp, so renaming one must not strip the other of its edits.
// Real temp directories, real files; the test renames the primary on disk
// first, exactly as Explorer has by the time the watcher reports it.

using System;
using System.IO;
using System.Linq;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class ExternalRenameSidecarTests : IDisposable
    {
        private readonly string _dir;

        public ExternalRenameSidecarTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-external-rename-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        private string P(string name) => Path.Combine(_dir, name);

        private string Write(string name, string content)
        {
            File.WriteAllText(P(name), content);
            return P(name);
        }

        private (string Old, string New) Explorer(string from, string to)
        {
            File.Move(P(from), P(to));
            return (P(from), P(to));
        }

        private static ExternalRenameSidecarResult Single(
            System.Collections.Generic.IReadOnlyList<ExternalRenameSidecarResult> results) => Assert.Single(results);

        [Fact]
        public void PairWithJpegRenamed_RawKeepsTheSidecar_JpegGetsACopy()
        {
            Write("IMG.CR3", "raw");
            Write("IMG.jpg", "jpg");
            Write("IMG.xmp", "<edits/>");

            var result = Single(LocalFileOperations.FollowExternalRenames(new[] { Explorer("IMG.jpg", "Beach.jpg") }));

            Assert.Equal(ExternalRenameSidecarOutcome.Carried, result.Outcome);
            Assert.Equal("<edits/>", File.ReadAllText(P("IMG.xmp")));
            Assert.Equal("<edits/>", File.ReadAllText(P("Beach.xmp")));
            Assert.Equal("raw", File.ReadAllText(P("IMG.CR3")));
        }

        [Fact]
        public void PairWithRawRenamed_JpegKeepsTheSidecar_RawGetsACopy()
        {
            Write("IMG.CR3", "raw");
            Write("IMG.jpg", "jpg");
            Write("IMG.xmp", "<edits/>");

            LocalFileOperations.FollowExternalRenames(new[] { Explorer("IMG.CR3", "Beach.CR3") });

            Assert.Equal("<edits/>", File.ReadAllText(P("IMG.xmp")));
            Assert.Equal("<edits/>", File.ReadAllText(P("Beach.xmp")));
        }

        [Fact]
        public void SinglePhotoRenamed_SidecarFollowsIt()
        {
            Write("IMG.jpg", "jpg");
            Write("IMG.xmp", "<edits/>");

            var result = Single(LocalFileOperations.FollowExternalRenames(new[] { Explorer("IMG.jpg", "Beach.jpg") }));

            Assert.Equal(ExternalRenameSidecarOutcome.Carried, result.Outcome);
            Assert.False(File.Exists(P("IMG.xmp")));
            Assert.Equal("<edits/>", File.ReadAllText(P("Beach.xmp")));
        }

        [Fact]
        public void PhotoWithoutSidecar_ReportsNoSidecar()
        {
            Write("IMG.jpg", "jpg");

            var result = Single(LocalFileOperations.FollowExternalRenames(new[] { Explorer("IMG.jpg", "Beach.jpg") }));

            Assert.Equal(ExternalRenameSidecarOutcome.NoSidecar, result.Outcome);
            Assert.False(File.Exists(P("Beach.xmp")));
        }

        [Fact]
        public void NonMediaFileWithTheSameStem_DoesNotClaimTheSidecar()
        {
            Write("IMG.jpg", "jpg");
            Write("IMG.txt", "notes");
            Write("IMG.xmp", "<edits/>");

            LocalFileOperations.FollowExternalRenames(new[] { Explorer("IMG.jpg", "Beach.jpg") });

            Assert.False(File.Exists(P("IMG.xmp")));
            Assert.Equal("<edits/>", File.ReadAllText(P("Beach.xmp")));
        }

        [Fact]
        public void OccupiedNewSidecar_IsNeverOverwritten_AndNothingMoves()
        {
            Write("IMG.CR3", "raw");
            Write("IMG.jpg", "jpg");
            Write("IMG.xmp", "<edits/>");
            Write("Beach.xmp", "<stranger/>");

            var result = Single(LocalFileOperations.FollowExternalRenames(new[] { Explorer("IMG.jpg", "Beach.jpg") }));

            Assert.Equal(ExternalRenameSidecarOutcome.Collision, result.Outcome);
            Assert.Equal("<edits/>", File.ReadAllText(P("IMG.xmp")));
            Assert.Equal("<stranger/>", File.ReadAllText(P("Beach.xmp")));
        }

        [Fact]
        public void OccupiedNewSidecar_OnASoloPhoto_KeepsTheOldSidecarWhereItIs()
        {
            Write("IMG.jpg", "jpg");
            Write("IMG.xmp", "<edits/>");
            Write("Beach.xmp", "<stranger/>");

            var result = Single(LocalFileOperations.FollowExternalRenames(new[] { Explorer("IMG.jpg", "Beach.jpg") }));

            Assert.Equal(ExternalRenameSidecarOutcome.Collision, result.Outcome);
            Assert.Equal("<edits/>", File.ReadAllText(P("IMG.xmp")));
            Assert.Equal("<stranger/>", File.ReadAllText(P("Beach.xmp")));
        }

        [Fact]
        public void DirectoryAtTheNewSidecarName_IsACollision()
        {
            Write("IMG.jpg", "jpg");
            Write("IMG.xmp", "<edits/>");
            Directory.CreateDirectory(P("Beach.xmp"));

            var result = Single(LocalFileOperations.FollowExternalRenames(new[] { Explorer("IMG.jpg", "Beach.jpg") }));

            Assert.Equal(ExternalRenameSidecarOutcome.Collision, result.Outcome);
            Assert.Equal("<edits/>", File.ReadAllText(P("IMG.xmp")));
            Assert.True(Directory.Exists(P("Beach.xmp")));
        }

        [Fact]
        public void IdenticalNewSidecar_IsJoined_NotACollision()
        {
            Write("IMG.CR3", "raw");
            Write("IMG.jpg", "jpg");
            Write("IMG.xmp", "<edits/>");
            Write("Beach.xmp", "<edits/>");

            var result = Single(LocalFileOperations.FollowExternalRenames(new[] { Explorer("IMG.jpg", "Beach.jpg") }));

            Assert.Equal(ExternalRenameSidecarOutcome.Joined, result.Outcome);
            Assert.Equal("<edits/>", File.ReadAllText(P("IMG.xmp")));
            Assert.Equal("<edits/>", File.ReadAllText(P("Beach.xmp")));
        }

        [Fact]
        public void IdenticalNewSidecar_OnASoloPhoto_ReleasesTheOldOne()
        {
            Write("IMG.jpg", "jpg");
            Write("IMG.xmp", "<edits/>");
            Write("Beach.xmp", "<edits/>");

            var result = Single(LocalFileOperations.FollowExternalRenames(new[] { Explorer("IMG.jpg", "Beach.jpg") }));

            Assert.Equal(ExternalRenameSidecarOutcome.Joined, result.Outcome);
            Assert.False(File.Exists(P("IMG.xmp")));
            Assert.Equal("<edits/>", File.ReadAllText(P("Beach.xmp")));
        }

        [Fact]
        public void ExtensionOnlyRename_LeavesTheSidecarAlone()
        {
            Write("IMG.CR3", "raw");
            Write("IMG.xmp", "<edits/>");

            var result = Single(LocalFileOperations.FollowExternalRenames(new[] { Explorer("IMG.CR3", "IMG.DNG") }));

            Assert.Equal(ExternalRenameSidecarOutcome.LeftInPlace, result.Outcome);
            Assert.Equal("<edits/>", File.ReadAllText(P("IMG.xmp")));
        }

        private string[] SidecarSpellings() =>
            Directory.EnumerateFiles(_dir, "*.xmp").Select(Path.GetFileName).OrderBy(n => n, StringComparer.Ordinal).ToArray()!;

        private bool FoldsCase() => File.Exists(P("img.XMP")) || File.Exists(P("IMG.xmp".ToLowerInvariant()));

        [Fact]
        public void CaseOnlyRename_OfASoloPhoto_ReCasesTheSidecar()
        {
            Write("IMG.jpg", "jpg");
            Write("IMG.xmp", "<edits/>");

            LocalFileOperations.FollowExternalRenames(new[] { Explorer("IMG.jpg", "img.jpg") });

            Assert.Equal(new[] { "img.xmp" }, SidecarSpellings());
            Assert.Equal("<edits/>", File.ReadAllText(P("img.xmp")));
        }

        [Fact]
        public void CaseOnlyRename_OfAPairHalf_LeavesTheSharedSidecarSpelling()
        {
            Write("IMG.CR3", "raw");
            Write("IMG.jpg", "jpg");
            Write("IMG.xmp", "<edits/>");
            var foldsCase = FoldsCase();

            LocalFileOperations.FollowExternalRenames(new[] { Explorer("IMG.jpg", "img.jpg") });

            Assert.Equal(
                foldsCase ? new[] { "IMG.xmp" } : new[] { "IMG.xmp", "img.xmp" },
                SidecarSpellings());
        }

        [Fact]
        public void MixedCaseHalves_RenamedToDifferentStems_AreDecidedTogether()
        {
            Write("IMG.CR3", "raw");
            Write("img.jpg", "jpg");
            Write("IMG.xmp", "<edits/>");
            if (!FoldsCase()) return;

            LocalFileOperations.FollowExternalRenames(new[]
            {
                Explorer("IMG.CR3", "Alpha.CR3"),
                Explorer("img.jpg", "Beta.jpg"),
            });

            Assert.Equal(new[] { "Alpha.xmp", "Beta.xmp" }, SidecarSpellings());
        }

        [Fact]
        public void LongNewStem_OfASoloPhoto_StillMovesTheSidecar()
        {
            var stem = new string('x', 215);
            Write("IMG.jpg", "jpg");
            Write("IMG.xmp", "<edits/>");

            var result = Single(LocalFileOperations.FollowExternalRenames(new[] { Explorer("IMG.jpg", stem + ".jpg") }));

            Assert.Equal(ExternalRenameSidecarOutcome.Carried, result.Outcome);
            Assert.Equal(new[] { stem + ".xmp" }, SidecarSpellings());
        }

        [Fact]
        public void RenameOntoAStemVacatedInTheSameBatch_EachSidecarFollowsItsPhoto()
        {
            Write("A.jpg", "ja");
            Write("B.CR3", "rb");
            Write("A.xmp", "<a/>");
            Write("B.xmp", "<b/>");

            var results = LocalFileOperations.FollowExternalRenames(new[]
            {
                Explorer("A.jpg", "C.jpg"),
                Explorer("B.CR3", "A.CR3"),
            });

            Assert.All(results, r => Assert.Equal(ExternalRenameSidecarOutcome.Carried, r.Outcome));
            Assert.Equal(new[] { "A.xmp", "C.xmp" }, SidecarSpellings());
            Assert.Equal("<b/>", File.ReadAllText(P("A.xmp")));
            Assert.Equal("<a/>", File.ReadAllText(P("C.xmp")));
        }

        [Fact]
        public void RenumberingPairs_ShiftEachSidecarWithItsPair()
        {
            foreach (var n in new[] { "2", "3" })
            {
                Write(n + ".CR3", "raw" + n);
                Write(n + ".jpg", "jpg" + n);
                Write(n + ".xmp", "<edits" + n + "/>");
            }

            LocalFileOperations.FollowExternalRenames(new[]
            {
                Explorer("3.CR3", "4.CR3"),
                Explorer("3.jpg", "4.jpg"),
                Explorer("2.CR3", "3.CR3"),
                Explorer("2.jpg", "3.jpg"),
            });

            Assert.Equal(new[] { "3.xmp", "4.xmp" }, SidecarSpellings());
            Assert.Equal("<edits3/>", File.ReadAllText(P("4.xmp")));
            Assert.Equal("<edits2/>", File.ReadAllText(P("3.xmp")));
        }

        private void Swap(string first, string second)
        {
            File.Move(P(first), P("swap.tmp"));
            File.Move(P(second), P(first));
            File.Move(P("swap.tmp"), P(second));
        }

        [Fact]
        public void Swap_WithOneSidecar_TheSidecarFollowsItsPhoto()
        {
            Write("A.jpg", "pixels-a");
            Write("B.jpg", "pixels-b");
            Write("A.xmp", "<a/>");
            Swap("A.jpg", "B.jpg");

            LocalFileOperations.FollowExternalRenames(new[] { (P("A.jpg"), P("B.jpg")), (P("B.jpg"), P("A.jpg")) });

            Assert.Equal(new[] { "B.xmp" }, SidecarSpellings());
            Assert.Equal("<a/>", File.ReadAllText(P("B.xmp")));
            Assert.Equal("pixels-a", File.ReadAllText(P("B.jpg")));
        }

        [Fact]
        public void ReadsOtherSidecar_IsSetOnlyWhenThePhotoEndsUpOnADifferentSidecar()
        {
            Write("IMG.jpg", "jpg");
            Write("IMG.xmp", "<edits/>");
            Write("Taken.xmp", "<stranger/>");
            Write("Plain.jpg", "p");
            Write("Plain.xmp", "<plain/>");
            Write("Free.jpg", "f");
            Write("Free.xmp", "<free/>");
            var renames = new[] { Explorer("IMG.jpg", "Taken.jpg"), Explorer("Plain.jpg", "Moved.jpg") };

            var results = LocalFileOperations.FollowExternalRenames(renames);

            Assert.True(results[0].ReadsOtherSidecar);
            Assert.False(results[1].ReadsOtherSidecar);
        }

        [Fact]
        public void PhotoWithoutSidecar_RenamedOntoAStemThatHasOne_ReadsOtherSidecar()
        {
            Write("IMG.jpg", "jpg");
            Write("Beach.xmp", "<other/>");

            var result = Single(LocalFileOperations.FollowExternalRenames(new[] { Explorer("IMG.jpg", "Beach.jpg") }));

            Assert.Equal(ExternalRenameSidecarOutcome.NoSidecar, result.Outcome);
            Assert.True(result.ReadsOtherSidecar);
        }

        [Fact]
        public void BothHalvesRenamedToTheSameStem_TheSidecarMovesOnce()
        {
            Write("IMG.CR3", "raw");
            Write("IMG.jpg", "jpg");
            Write("IMG.xmp", "<edits/>");

            LocalFileOperations.FollowExternalRenames(new[]
            {
                Explorer("IMG.CR3", "Beach.CR3"),
                Explorer("IMG.jpg", "Beach.jpg"),
            });

            Assert.False(File.Exists(P("IMG.xmp")));
            Assert.Equal("<edits/>", File.ReadAllText(P("Beach.xmp")));
        }

        [Fact]
        public void BothHalvesRenamedToDifferentStems_EachGetsTheSidecar()
        {
            Write("IMG.CR3", "raw");
            Write("IMG.jpg", "jpg");
            Write("IMG.xmp", "<edits/>");

            LocalFileOperations.FollowExternalRenames(new[]
            {
                Explorer("IMG.CR3", "Alpha.CR3"),
                Explorer("IMG.jpg", "Beta.jpg"),
            });

            Assert.False(File.Exists(P("IMG.xmp")));
            Assert.Equal("<edits/>", File.ReadAllText(P("Alpha.xmp")));
            Assert.Equal("<edits/>", File.ReadAllText(P("Beta.xmp")));
        }

        [Fact]
        public void BothHalvesRenamed_OneTargetTaken_KeepsTheOldSidecarForTheLoser()
        {
            Write("IMG.CR3", "raw");
            Write("IMG.jpg", "jpg");
            Write("IMG.xmp", "<edits/>");
            Write("Beta.xmp", "<stranger/>");

            var results = LocalFileOperations.FollowExternalRenames(new[]
            {
                Explorer("IMG.CR3", "Alpha.CR3"),
                Explorer("IMG.jpg", "Beta.jpg"),
            });

            Assert.Equal(ExternalRenameSidecarOutcome.Collision, results[1].Outcome);
            Assert.Equal("<edits/>", File.ReadAllText(P("IMG.xmp")));
            Assert.Equal("<edits/>", File.ReadAllText(P("Alpha.xmp")));
            Assert.Equal("<stranger/>", File.ReadAllText(P("Beta.xmp")));
        }
    }
}
