// RelocateSharedSidecarTests — the shared-sidecar ownership rule (#4758,
// docs/xmp-canonical-format.md § "Moving, renaming and trashing a photo"):
// IMG_1.CR3 and IMG_1.JPG both read IMG_1.xmp, so a relocate must never take,
// overwrite or self-delete a sidecar another photo still uses. Real temp
// directories, real files; every pre-existing .xmp is asserted byte-identical.

using System;
using System.IO;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
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
