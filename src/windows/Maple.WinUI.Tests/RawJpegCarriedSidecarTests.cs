// RawJpegCarriedSidecarTests — the JPEG of a pair may join the sidecar its RAW
// just carried only when its own source sidecar is that same file (#5848).
// Two different source sidecars that happen to resolve to one destination name
// must not let the JPEG's edits be treated as already carried and then deleted.

using System;
using System.IO;
using Maple.WinUI.Services.FileOperations;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class RawJpegCarriedSidecarTests : IDisposable
    {
        private readonly string _dir;

        public RawJpegCarriedSidecarTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-carried-sidecar-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path.Combine(_dir, "a"));
            Directory.CreateDirectory(Path.Combine(_dir, "b"));
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { }
        }

        private string P(params string[] parts) => Path.Combine(_dir, Path.Combine(parts));

        [Fact]
        public void TwoDistinctSourceSidecars_CarryNothingToTheJpeg()
        {
            var rawSidecar = P("a", "IMG.xmp");
            var jpegSidecar = P("b", "img.xmp");
            File.WriteAllText(rawSidecar, "<raw edits/>");
            File.WriteAllText(jpegSidecar, "<jpeg edits/>");

            var carried = LocalFileOperations.CarriedSidecarFor(jpegSidecar, rawSidecar, P("dest", "IMG.xmp"));

            Assert.Null(carried);
        }

        [Fact]
        public void OneSharedSourceSidecar_IsCarriedToTheJpeg()
        {
            var shared = P("a", "IMG.xmp");
            File.WriteAllText(shared, "<edits/>");

            var carried = LocalFileOperations.CarriedSidecarFor(shared, shared, P("dest", "IMG.xmp"));

            Assert.Equal(P("dest", "IMG.xmp"), carried);
        }

        [Fact]
        public void ARawWithoutASidecar_CarriesNothing()
        {
            var jpegSidecar = P("a", "IMG.xmp");
            File.WriteAllText(jpegSidecar, "<jpeg edits/>");

            Assert.Null(LocalFileOperations.CarriedSidecarFor(jpegSidecar, jpegSidecar, null));
        }
    }
}
