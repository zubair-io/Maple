// RawJpegStackTrashTests — deleting a stacked RAW+JPEG tile (#5050, #5848):
// both files go to the same Trash together. Real temp directories and files;
// only the Recycle Bin shell call is faked (Support/FakeRecycleBinService.cs).

using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Services.FileOperations;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RawJpegStackTrashTests : IDisposable
    {
        private readonly string _root;

        public RawJpegStackTrashTests()
        {
            _root = Path.Combine(Path.GetTempPath(), "maple-winui-stack-trash-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(P("Album"));
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

        private string[] Names(params string[] folder) =>
            Directory.Exists(P(folder))
                ? Directory.EnumerateFiles(P(folder)).Select(Path.GetFileName).OrderBy(n => n, StringComparer.Ordinal).ToArray()!
                : Array.Empty<string>();

        private (string Raw, string Jpeg, string Sidecar) WritePair() => (
            Write("raw", "Album", "IMG_1.CR3"),
            Write("jpeg", "Album", "IMG_1.JPG"),
            Write("<edits/>", "Album", "IMG_1.xmp"));

        [Fact]
        public async Task RecycleBin_TakesTheRawTheJpegAndTheirSidecarInOneCall()
        {
            var (raw, jpeg, sidecar) = WritePair();
            var fake = new FakeRecycleBinService { Succeeds = true };

            var outcome = await LocalFileOperations.TrashStackAsync(raw, jpeg, _root, fake);

            Assert.Equal(new[] { raw, jpeg, sidecar }, Assert.Single(fake.Calls));
            Assert.Equal(raw, outcome.PrimaryPath);
            Assert.Equal(jpeg, outcome.CompanionPath);
            Assert.True(outcome.SidecarFollowed);
        }

        [Fact]
        public async Task RecycleBin_LeavesTheSidecarAThirdSameStemPhotoStillReads()
        {
            var (raw, jpeg, _) = WritePair();
            Write("heic", "Album", "IMG_1.HEIC");
            var fake = new FakeRecycleBinService { Succeeds = true };

            var outcome = await LocalFileOperations.TrashStackAsync(raw, jpeg, _root, fake);

            Assert.Equal(new[] { raw, jpeg }, Assert.Single(fake.Calls));
            Assert.False(outcome.SidecarFollowed);
        }

        [Fact]
        public async Task WithoutARecycleBin_BothFilesMoveToMapleTrashUnderOneName()
        {
            var (raw, jpeg, _) = WritePair();
            var fake = new FakeRecycleBinService { Succeeds = false };

            var outcome = await LocalFileOperations.TrashStackAsync(raw, jpeg, _root, fake);

            Assert.Equal(P(".maple", "trash", "Album", "IMG_1.CR3"), outcome.PrimaryPath);
            Assert.Equal(P(".maple", "trash", "Album", "IMG_1.JPG"), outcome.CompanionPath);
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" }, Names(".maple", "trash", "Album"));
            Assert.Empty(Names("Album"));
        }

        [Fact]
        public async Task MapleTrash_AlreadyHoldingThatJpegName_SuffixesThePairTogether()
        {
            var (raw, jpeg, _) = WritePair();
            Write("older jpeg", ".maple", "trash", "Album", "IMG_1.JPG");
            var fake = new FakeRecycleBinService { Succeeds = false };

            var outcome = await LocalFileOperations.TrashStackAsync(raw, jpeg, _root, fake);

            Assert.Equal(P(".maple", "trash", "Album", "IMG_1.1.CR3"), outcome.PrimaryPath);
            Assert.Equal(P(".maple", "trash", "Album", "IMG_1.1.JPG"), outcome.CompanionPath);
            Assert.Equal("older jpeg", File.ReadAllText(P(".maple", "trash", "Album", "IMG_1.JPG")));
            Assert.Empty(Names("Album"));
        }

        [Fact]
        public async Task ATileDelete_TrashesThePair_AndOneRestoreBringsBothHalvesBackToTheirOwnNames()
        {
            var (raw, jpeg, _) = WritePair();
            Write("older raw", ".maple", "trash", "Album", "IMG_1.CR3");
            var item = new TrashSourceItem(raw, raw, "IMG_1.CR3", jpeg);

            var outcomes = await TrashSelectionLogic.ApplySequentialAsync(
                new[] { item }, _ => _root, new FakeRecycleBinService { Succeeds = false });

            var outcome = Assert.Single(outcomes);
            Assert.Equal(TrashOutcomeKind.Trashed, outcome.Kind);
            Assert.Equal(TrashDestinationKind.MapleTrashFolder, outcome.DestinationKind);
            Assert.Empty(Names("Album"));

            await LocalFileOperations.RestoreFromMapleTrashAsync(P(".maple", "trash", "Album", "IMG_1.1.CR3"), _root);

            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" }, Names("Album"));
            Assert.Equal("raw", File.ReadAllText(P("Album", "IMG_1.CR3")));
            Assert.Equal("jpeg", File.ReadAllText(P("Album", "IMG_1.JPG")));
            Assert.Equal("<edits/>", File.ReadAllText(P("Album", "IMG_1.xmp")));
            Assert.Equal(new[] { "IMG_1.CR3" }, Names(".maple", "trash", "Album"));
        }

        [Fact]
        public async Task RecycleBin_FailingAfterTheRawWasRecycled_ReportsWhatWasRecycledAndWhatRemains()
        {
            var (raw, jpeg, _) = WritePair();
            var fake = new FakeRecycleBinService { RecyclesFirstPathThenFails = true };

            var failure = await Assert.ThrowsAsync<FileOperationException>(
                () => LocalFileOperations.TrashStackAsync(raw, jpeg, _root, fake));

            Assert.Contains("IMG_1.CR3", failure.Message);
            Assert.Contains("Recycle Bin", failure.Message);
            Assert.Contains("IMG_1.JPG", failure.Message);
            Assert.Contains("IMG_1.xmp", failure.Message);
            Assert.DoesNotContain("no longer exists", failure.Message);
            Assert.Equal(new[] { "IMG_1.JPG", "IMG_1.xmp" }, Names("Album"));
            Assert.Empty(Names(".maple", "trash", "Album"));
        }

        [Fact]
        public async Task ATileDelete_ThroughTheRecycleBin_ReportsTheRecycleBin()
        {
            var (raw, jpeg, sidecar) = WritePair();
            var fake = new FakeRecycleBinService { Succeeds = true };

            var outcomes = await TrashSelectionLogic.ApplySequentialAsync(
                new[] { new TrashSourceItem(raw, raw, "IMG_1.CR3", jpeg) }, _ => _root, fake);

            Assert.Equal(TrashDestinationKind.RecycleBin, Assert.Single(outcomes).DestinationKind);
            Assert.Equal(new[] { raw, jpeg, sidecar }, Assert.Single(fake.Calls));
        }

        [Fact]
        public async Task APairWhoseJpegIsGone_IsRefusedBeforeEitherFileIsTrashed()
        {
            var (raw, jpeg, _) = WritePair();
            File.Delete(jpeg);
            var fake = new FakeRecycleBinService { Succeeds = true };

            var outcomes = await TrashSelectionLogic.ApplySequentialAsync(
                new[] { new TrashSourceItem(raw, raw, "IMG_1.CR3", jpeg) }, _ => _root, fake);

            Assert.Equal(TrashOutcomeKind.Error, Assert.Single(outcomes).Kind);
            Assert.Empty(fake.Calls);
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.xmp" }, Names("Album"));
            Assert.Empty(Names(".maple", "trash", "Album"));
        }
    }
}
