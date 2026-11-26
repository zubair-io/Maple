// RawJpegStackLargeSidecarTests — a RAW+JPEG pair whose shared sidecar is
// past the sidecar editing limit still moves, renames and trashes as one unit
// (#5848). The JPEG recognises the sidecar its own RAW's plan just carried by
// path; an unrelated file's identical oversized sidecar is still a collision.

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
    public class RawJpegStackLargeSidecarTests : IDisposable
    {
        private readonly string _dir;
        private readonly string _oversized = new('x', (int)SidecarStore.MaxSidecarBytes + 1);

        public RawJpegStackLargeSidecarTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-stack-large-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(P("src"));
            Directory.CreateDirectory(P("dest"));
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

        private string[] Names(string folder) =>
            Directory.EnumerateFiles(P(folder)).Select(Path.GetFileName).OrderBy(n => n, StringComparer.Ordinal).ToArray()!;

        private (string Raw, string Jpeg) WritePair() =>
            (Write("raw", "src", "IMG_1.CR3"), Write("jpeg", "src", "IMG_1.JPG"));

        [Fact]
        public async Task Move_OfAPairWithAnOversizedSidecar_LandsBothFilesAndTheSidecar()
        {
            var (raw, jpeg) = WritePair();
            Write(_oversized, "src", "IMG_1.xmp");

            var outcome = await LocalFileOperations.RelocateStackAsync(
                raw, jpeg, P("dest"), null, RelocateMode.Move, CollisionPolicy.Fail);

            Assert.Equal(P("dest", "IMG_1.JPG"), outcome.CompanionPath);
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" }, Names("dest"));
            Assert.Equal(_oversized, File.ReadAllText(P("dest", "IMG_1.xmp")));
            Assert.Empty(Names("src"));
        }

        [Fact]
        public async Task Rename_OfAPairWithAnOversizedSidecar_RenamesAllThreeFiles()
        {
            var (raw, jpeg) = WritePair();
            Write(_oversized, "src", "IMG_1.xmp");

            await LocalFileOperations.RelocateStackAsync(
                raw, jpeg, P("src"), "Trip.CR3", RelocateMode.Move, CollisionPolicy.Fail);

            Assert.Equal(new[] { "Trip.CR3", "Trip.JPG", "Trip.xmp" }, Names("src"));
            Assert.Equal(_oversized, File.ReadAllText(P("src", "Trip.xmp")));
        }

        [Fact]
        public async Task KeepBoth_OfAPairWithAnOversizedSidecar_PicksOneFreeNameForAllThree()
        {
            var (raw, jpeg) = WritePair();
            Write(_oversized, "src", "IMG_1.xmp");
            Write("older raw", "dest", "IMG_1.CR3");

            var outcome = await LocalFileOperations.RelocateStackAsync(
                raw, jpeg, P("dest"), null, RelocateMode.Move, CollisionPolicy.AutoSuffix);

            Assert.Equal(P("dest", "IMG_1.1.JPG"), outcome.CompanionPath);
            Assert.Equal(new[] { "IMG_1.1.CR3", "IMG_1.1.JPG", "IMG_1.1.xmp", "IMG_1.CR3" }, Names("dest"));
        }

        [Fact]
        public async Task Trash_OfAPairWithAnOversizedSidecar_MovesAllThreeToMapleTrash()
        {
            var (raw, jpeg) = WritePair();
            Write(_oversized, "src", "IMG_1.xmp");

            await LocalFileOperations.TrashStackAsync(raw, jpeg, _dir, new FakeRecycleBinService { Succeeds = false });

            Assert.Empty(Names("src"));
            Assert.Equal(new[] { "IMG_1.CR3", "IMG_1.JPG", "IMG_1.xmp" }, Names(Path.Combine(".maple", "trash", "src")));
        }

        [Fact]
        public async Task AnUnrelatedFilesIdenticalOversizedSidecar_IsStillACollision()
        {
            var jpeg = Write("jpeg", "src", "IMG_1.JPG");
            Write(_oversized, "src", "IMG_1.xmp");
            Write("other photo", "dest", "IMG_1.HEIC");
            Write(_oversized, "dest", "IMG_1.xmp");

            var failure = await Assert.ThrowsAsync<FileOperationException>(() => LocalFileOperations.RelocateAsync(
                jpeg, P("dest"), null, RelocateMode.Move, CollisionPolicy.Fail));

            Assert.Equal(FileOperationErrorKind.DestinationExists, failure.Kind);
            Assert.Equal(new[] { "IMG_1.HEIC", "IMG_1.xmp" }, Names("dest"));
            Assert.Equal(new[] { "IMG_1.JPG", "IMG_1.xmp" }, Names("src"));
        }
    }
}
