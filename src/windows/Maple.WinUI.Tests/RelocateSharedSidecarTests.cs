// RelocateSharedSidecarTests — the shared-sidecar ownership rule (#4758,
// docs/xmp-canonical-format.md § "Moving, renaming and trashing a photo"):
// IMG_1.CR3 and IMG_1.JPG both read IMG_1.xmp, so a relocate must never take,
// overwrite or self-delete a sidecar another photo still uses. Real temp
// directories, real files; every pre-existing .xmp is asserted byte-identical.

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RelocateSharedSidecarTests : IDisposable
    {
        private readonly string _dir;

        public RelocateSharedSidecarTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-shared-sidecar-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        private string P(params string[] parts) => Path.Combine(_dir, Path.Combine(parts));

        private string Write(string content, params string[] parts)
        {
            var full = P(parts);
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(full, content);
            return full;
        }

        private void AssertContent(string expected, params string[] parts) =>
            Assert.Equal(expected, File.ReadAllText(P(parts)));

        [Fact]
        public async Task ExtensionOnlyRename_ThroughAnAliasedFolder_KeepsTheSoleSidecar()
        {
            var raw = Write("raw", "photos", "X.CR3");
            Write("<only/>", "photos", "X.xmp");
            Directory.CreateSymbolicLink(P("alias"), P("photos"));

            await LocalFileOperations.RelocateAsync(
                raw, P("alias"), "X.DNG", RelocateMode.Move, CollisionPolicy.AutoSuffix);

            AssertContent("raw", "photos", "X.DNG");
            AssertContent("<only/>", "photos", "X.xmp");
            Assert.False(File.Exists(raw));
        }

        [Fact]
        public async Task CaseOnlyRename_FollowsTheFolderCaseRule()
        {
            var raw = Write("raw", "photos", "x.CR3");
            Write("<edits/>", "photos", "x.xmp");
            var foldsCase = File.Exists(P("photos", "X.CR3"));

            await LocalFileOperations.RelocateAsync(
                raw, P("photos"), "X.DNG", RelocateMode.Move, CollisionPolicy.AutoSuffix);

            // A case-sensitive folder (WSL-style NTFS, case-sensitive APFS)
            // gives X.DNG its own X.xmp; a folding one keeps the one sidecar.
            var names = Directory.EnumerateFiles(P("photos")).Select(Path.GetFileName).OrderBy(n => n, StringComparer.Ordinal);
            Assert.Equal(foldsCase ? new[] { "X.DNG", "x.xmp" } : new[] { "X.DNG", "X.xmp" }, names);
            Assert.Equal("<edits/>", File.ReadAllText(P("photos", foldsCase ? "x.xmp" : "X.xmp")));
        }

        [Fact]
        public async Task Replace_WithoutIncomingSidecar_IgnoresANonMediaFileWithTheSameStem()
        {
            var raw = Write("new", "src", "IMG_1.CR3");
            Write("old", "album", "IMG_1.CR3");
            Write("notes", "album", "IMG_1.txt");
            Write("<stale/>", "album", "IMG_1.xmp");

            await LocalFileOperations.RelocateAsync(
                raw, P("album"), null, RelocateMode.Move, CollisionPolicy.Replace);

            AssertContent("new", "album", "IMG_1.CR3");
            Assert.False(File.Exists(P("album", "IMG_1.xmp")));
            AssertContent("notes", "album", "IMG_1.txt");
        }

        [Fact]
        public async Task CaseOnlyRename_WithASiblingStillReadingTheSidecar_KeepsItsSidecar()
        {
            var raw = Write("raw", "photos", "x.CR3");
            Write("jpg", "photos", "x.JPG");
            Write("<shared/>", "photos", "x.xmp");
            var foldsCase = File.Exists(P("photos", "X.CR3"));

            await LocalFileOperations.RelocateAsync(
                raw, P("photos"), "X.CR3", RelocateMode.Move, CollisionPolicy.AutoSuffix);

            AssertContent("<shared/>", "photos", "x.xmp");
            if (!foldsCase) AssertContent("<shared/>", "photos", "X.xmp");
        }

        [Fact]
        public async Task Move_PhotoWhoseNameContainsTmp_StillSharesWithItsSibling()
        {
            var raw = Write("raw", "src", "IMG.tmp.CR3");
            Write("jpg", "src", "IMG.tmp.JPG");
            Write("staging", "src", "IMG.tmp.CR3.tmp.123-0123abcd");
            Write("<shared/>", "src", "IMG.tmp.xmp");

            await LocalFileOperations.RelocateAsync(
                raw, P("album"), null, RelocateMode.Move, CollisionPolicy.Fail);

            AssertContent("<shared/>", "album", "IMG.tmp.xmp");
            AssertContent("<shared/>", "src", "IMG.tmp.xmp");
        }

        [Fact]
        public async Task Move_SourceSidecarSharedWithJpeg_IsCopiedNotMoved()
        {
            var raw = Write("raw", "src", "IMG_1.CR3");
            Write("jpg", "src", "IMG_1.JPG");
            Write("<shared/>", "src", "IMG_1.xmp");

            var outcome = await LocalFileOperations.RelocateAsync(
                raw, P("album"), null, RelocateMode.Move, CollisionPolicy.Fail);

            Assert.True(outcome.SidecarFollowed);
            AssertContent("<shared/>", "album", "IMG_1.xmp");
            AssertContent("<shared/>", "src", "IMG_1.xmp");
            Assert.False(File.Exists(raw));
        }

        [Fact]
        public async Task SameFolderRename_SourceSidecarSharedWithJpeg_IsCopiedNotMoved()
        {
            var raw = Write("raw", "IMG_1.CR3");
            Write("jpg", "IMG_1.JPG");
            Write("<shared/>", "IMG_1.xmp");

            var outcome = await LocalFileOperations.RelocateAsync(
                raw, _dir, "IMG_2.CR3", RelocateMode.Move, CollisionPolicy.Fail);

            Assert.Equal(P("IMG_2.xmp"), outcome.SidecarPath);
            AssertContent("<shared/>", "IMG_2.xmp");
            AssertContent("<shared/>", "IMG_1.xmp");
        }

        [Fact]
        public async Task Fail_DestinationSiblingSidecar_ThrowsAndChangesNothing()
        {
            var raw = Write("new", "src", "IMG_1.CR3");
            Write("<new/>", "src", "IMG_1.xmp");
            Write("jpg", "album", "IMG_1.JPG");
            Write("<sibling/>", "album", "IMG_1.xmp");

            var ex = await Assert.ThrowsAsync<FileOperationException>(() => LocalFileOperations.RelocateAsync(
                raw, P("album"), null, RelocateMode.Move, CollisionPolicy.Fail));

            Assert.Equal(FileOperationErrorKind.DestinationExists, ex.Kind);
            Assert.False(File.Exists(P("album", "IMG_1.CR3")));
            AssertContent("<sibling/>", "album", "IMG_1.xmp");
            AssertContent("new", "src", "IMG_1.CR3");
            AssertContent("<new/>", "src", "IMG_1.xmp");
        }

        [Fact]
        public async Task KeepBoth_DestinationSiblingSidecar_SuffixesPhotoAndSidecarTogether()
        {
            var raw = Write("new", "src", "IMG_1.CR3");
            Write("<new/>", "src", "IMG_1.xmp");
            Write("jpg", "album", "IMG_1.JPG");
            Write("<sibling/>", "album", "IMG_1.xmp");

            var outcome = await LocalFileOperations.RelocateAsync(
                raw, P("album"), null, RelocateMode.Move, CollisionPolicy.AutoSuffix);

            Assert.True(outcome.RenamedDueToCollision);
            Assert.Equal(P("album", "IMG_1.1.CR3"), outcome.PrimaryPath);
            AssertContent("<new/>", "album", "IMG_1.1.xmp");
            AssertContent("<sibling/>", "album", "IMG_1.xmp");
            Assert.False(File.Exists(P("src", "IMG_1.xmp")));
        }

        [Fact]
        public async Task KeepBoth_DestinationOrphanSidecar_SuffixesEvenWithoutOwnSidecar()
        {
            var raw = Write("new", "src", "IMG_1.CR3");
            Write("<orphan/>", "album", "IMG_1.xmp");

            var outcome = await LocalFileOperations.RelocateAsync(
                raw, P("album"), null, RelocateMode.Move, CollisionPolicy.AutoSuffix);

            Assert.True(outcome.RenamedDueToCollision);
            Assert.False(outcome.SidecarFollowed);
            Assert.Equal(P("album", "IMG_1.1.CR3"), outcome.PrimaryPath);
            AssertContent("<orphan/>", "album", "IMG_1.xmp");
        }

        [Fact]
        public async Task Replace_SidecarOwnedByDestinationSibling_FailsWithNothingChanged()
        {
            var raw = Write("new", "src", "IMG_1.CR3");
            Write("<new/>", "src", "IMG_1.xmp");
            Write("old", "album", "IMG_1.CR3");
            Write("jpg", "album", "IMG_1.JPG");
            Write("<sibling/>", "album", "IMG_1.xmp");

            await Assert.ThrowsAsync<FileOperationException>(() => LocalFileOperations.RelocateAsync(
                raw, P("album"), null, RelocateMode.Move, CollisionPolicy.Replace));

            AssertContent("old", "album", "IMG_1.CR3");
            AssertContent("<sibling/>", "album", "IMG_1.xmp");
            AssertContent("new", "src", "IMG_1.CR3");
            AssertContent("<new/>", "src", "IMG_1.xmp");
        }

        [Fact]
        public async Task Replace_IncomingWithoutSidecar_KeepsSiblingOwnedSidecar()
        {
            var raw = Write("new", "src", "IMG_1.CR3");
            Write("old", "album", "IMG_1.CR3");
            Write("jpg", "album", "IMG_1.JPG");
            Write("<sibling/>", "album", "IMG_1.xmp");

            var outcome = await LocalFileOperations.RelocateAsync(
                raw, P("album"), null, RelocateMode.Move, CollisionPolicy.Replace);

            Assert.False(outcome.SidecarFollowed);
            AssertContent("new", "album", "IMG_1.CR3");
            AssertContent("<sibling/>", "album", "IMG_1.xmp");
        }

        [Fact]
        public async Task Replace_UnownedDestinationSidecar_IsReplacedByIncomingSidecar()
        {
            var raw = Write("new", "src", "IMG_1.CR3");
            Write("<new/>", "src", "IMG_1.xmp");
            Write("old", "album", "IMG_1.CR3");
            Write("<old/>", "album", "IMG_1.xmp");

            await LocalFileOperations.RelocateAsync(
                raw, P("album"), null, RelocateMode.Move, CollisionPolicy.Replace);

            AssertContent("new", "album", "IMG_1.CR3");
            AssertContent("<new/>", "album", "IMG_1.xmp");
            Assert.False(File.Exists(P("src", "IMG_1.xmp")));
        }

        [Theory]
        [InlineData("photo.jpg", "photo.jpeg")]
        [InlineData("X.CR3", "X.DNG")]
        public async Task ExtensionOnlyRename_KeepsTheSoleSidecar(string from, string to)
        {
            var source = Write("pixels", from);
            var sidecar = Write("<only/>", Path.ChangeExtension(from, ".xmp"));

            var outcome = await LocalFileOperations.RelocateAsync(
                source, _dir, to, RelocateMode.Move, CollisionPolicy.Fail);

            Assert.True(outcome.SidecarFollowed);
            Assert.Equal(sidecar, outcome.SidecarPath);
            Assert.Equal("<only/>", File.ReadAllText(sidecar));
            AssertContent("pixels", to);
            Assert.False(File.Exists(source));
        }

        [Fact]
        public async Task RawJpegPairMovedOneAfterTheOther_JoinsOneSidecarOnTheSameStem()
        {
            var raw = Write("raw", "src", "IMG_1.CR3");
            var jpg = Write("jpg", "src", "IMG_1.JPG");
            Write("<shared/>", "src", "IMG_1.xmp");

            var first = await LocalFileOperations.RelocateAsync(
                raw, P("album"), null, RelocateMode.Move, CollisionPolicy.Fail);
            var second = await LocalFileOperations.RelocateAsync(
                jpg, P("album"), null, RelocateMode.Move, CollisionPolicy.Fail);

            Assert.False(first.RenamedDueToCollision);
            Assert.False(second.RenamedDueToCollision);
            Assert.Equal(P("album", "IMG_1.JPG"), second.PrimaryPath);
            Assert.Equal(P("album", "IMG_1.xmp"), second.SidecarPath);
            Assert.Equal(
                new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" },
                Directory.GetFiles(P("album")).Select(Path.GetFileName).OrderBy(n => n, StringComparer.Ordinal));
            AssertContent("<shared/>", "album", "IMG_1.xmp");
            Assert.Empty(Directory.GetFiles(P("src")));
        }

        [Fact]
        public void SidecarAlreadyCarried_IdenticalFilesPastTheSidecarLimit_IsNotAJoin()
        {
            var oversized = new string('x', (int)SidecarStore.MaxSidecarBytes + 1);
            var source = Write(oversized, "src", "IMG_1.xmp");
            var destination = Write(oversized, "album", "IMG_1.xmp");

            Assert.False(LocalFileOperations.SidecarAlreadyCarried(source, destination));
        }

        [Fact]
        public void SameSidecarPath_ThroughCyclicFolderLinks_StopsAndKeepsTheSidecar()
        {
            Write("<only/>", "photos", "X.xmp");
            Directory.CreateSymbolicLink(P("loop-a"), P("loop-b", "inner"));
            Directory.CreateSymbolicLink(P("loop-b"), P("loop-a"));

            Assert.True(LocalFileOperations.SameSidecarPath(P("loop-a", "X.xmp"), P("photos", "X.xmp")));
        }

        [Fact]
        public void SameSidecarPath_ThroughALinkToAMissingFolder_StillResolvesTheLink()
        {
            Directory.CreateSymbolicLink(P("dangling"), P("not-yet"));

            Assert.True(LocalFileOperations.SameSidecarPath(P("dangling", "X.xmp"), P("not-yet", "X.xmp")));
        }

        [Fact]
        public async Task DragBatchWithBothHalvesOfAPair_KeepsThePairOnOneStem()
        {
            Write("raw", "src", "IMG_1.CR3");
            Write("jpg", "src", "IMG_1.JPG");
            Write("<shared/>", "src", "IMG_1.xmp");
            var items = new[] { "IMG_1.CR3", "IMG_1.JPG" }
                .Select(n => new DragMoveSourceItem(n, P("src"), n, P("src", n)))
                .ToArray();

            var outcomes = await DragMoveLogic.ApplySequentialAsync(
                items, P("album"), RelocateMode.Move, Array.Empty<string>(), DragMoveCollisionChoice.KeepBoth);

            Assert.All(outcomes, o => Assert.Equal(DragMoveOutcomeKind.Relocated, o.Kind));
            Assert.Equal(new[] { P("album", "IMG_1.CR3"), P("album", "IMG_1.JPG") }, outcomes.Select(o => o.NewPath));
            AssertContent("<shared/>", "album", "IMG_1.xmp");
            Assert.False(File.Exists(P("album", "IMG_1.1.xmp")));
            Assert.Empty(Directory.GetFiles(P("src")));
        }

        [Fact]
        public async Task AutoSuffix_SkipsACandidateWhoseSidecarBelongsToAnotherFile()
        {
            // #4823: photo.1.dng is free, but photo.1.xmp is photo.1.jpg's.
            var raw = Write("new", "src", "photo.dng");
            Write("<new/>", "src", "photo.xmp");
            Write("old", "album", "photo.dng");
            Write("<old/>", "album", "photo.xmp");
            Write("jpg", "album", "photo.1.jpg");
            Write("<batch-member/>", "album", "photo.1.xmp");

            var outcome = await LocalFileOperations.RelocateAsync(
                raw, P("album"), null, RelocateMode.Move, CollisionPolicy.AutoSuffix);

            Assert.Equal(P("album", "photo.2.dng"), outcome.PrimaryPath);
            AssertContent("<new/>", "album", "photo.2.xmp");
            AssertContent("<batch-member/>", "album", "photo.1.xmp");
            AssertContent("<old/>", "album", "photo.xmp");
        }

        [Fact]
        public async Task Trash_RecycleBin_LeavesSidecarSharedWithJpeg()
        {
            var raw = Write("raw", "IMG_1.CR3");
            Write("jpg", "IMG_1.JPG");
            var sidecar = Write("<shared/>", "IMG_1.xmp");
            var recycleBin = new FakeRecycleBinService { Succeeds = true };

            var outcome = await LocalFileOperations.TrashAsync(raw, _dir, recycleBin);

            Assert.Equal(new[] { raw }, Assert.Single(recycleBin.Calls));
            Assert.False(outcome.SidecarFollowed);
            Assert.Equal("<shared/>", File.ReadAllText(sidecar));
        }

        [Fact]
        public async Task Trash_MapleTrashFolder_CopiesSidecarSharedWithJpeg()
        {
            var raw = Write("raw", "album", "IMG_1.CR3");
            Write("jpg", "album", "IMG_1.JPG");
            Write("<shared/>", "album", "IMG_1.xmp");

            var outcome = await LocalFileOperations.TrashAsync(raw, _dir, new FakeRecycleBinService { Succeeds = false });

            Assert.Equal("<shared/>", File.ReadAllText(outcome.SidecarPath!));
            AssertContent("<shared/>", "album", "IMG_1.xmp");
            Assert.False(File.Exists(raw));
        }
    }
}
