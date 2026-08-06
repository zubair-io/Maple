// SidecarStoreRoundTripTests — real files in a temp directory, no mocks
// (CLAUDE.md § Conventions: "No mocks for the sidecar layer in tests.
// Round-trip against real .xmp files in a temp directory. XMP is the
// contract; mocks let bugs through."). Exercises `SidecarStore`'s
// same-stem path derivation and atomic temp-file-then-move write, which
// the in-memory `XmpParser`/`XmpWriter` tests above never touch.

using System;
using System.IO;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class SidecarStoreRoundTripTests : IDisposable
    {
        private readonly string _dir;

        public SidecarStoreRoundTripTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "maple-winui-xmp-tests-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); }
            catch (IOException) { /* best-effort cleanup */ }
        }

        [Fact]
        public void SidecarPathIsSameStemWithXmpExtension()
        {
            var rawPath = Path.Combine(_dir, "photo.dng");

            Assert.Equal(Path.Combine(_dir, "photo.xmp"), SidecarStore.SidecarPathFor(rawPath));
        }

        [Fact]
        public void LoadReturnsNullWhenNoSidecarExists()
        {
            var rawPath = Path.Combine(_dir, "no-sidecar.dng");

            Assert.Null(SidecarStore.Load(rawPath));
        }

        [Fact]
        public void SaveThenLoadRoundTripsThroughARealFile()
        {
            var rawPath = Path.Combine(_dir, "photo.dng");
            var written = WindowsFixtureModel.BuildDocument();

            SidecarStore.Save(rawPath, written);
            var loaded = SidecarStore.Load(rawPath);

            Assert.NotNull(loaded);
            AdjustmentStateAssert.Equal(written.Adjustments, loaded!.Adjustments);
            Assert.Equal(written.Rating, loaded.Rating);
            Assert.Equal(written.Flag, loaded.Flag);
            Assert.Equal(written.ColorLabel, loaded.ColorLabel);
        }

        [Fact]
        public void SaveIsAtomicNoTempFileLeftBehindOnSuccess()
        {
            var rawPath = Path.Combine(_dir, "photo.dng");

            SidecarStore.Save(rawPath, WindowsFixtureModel.BuildDocument());

            var entries = Directory.GetFiles(_dir);
            Assert.Single(entries);
            Assert.Equal(SidecarStore.SidecarPathFor(rawPath), entries[0]);
        }

        [Fact]
        public void SaveOverwritesAnExistingSidecar()
        {
            var rawPath = Path.Combine(_dir, "photo.dng");
            SidecarStore.Save(rawPath, new XmpSidecarDocument { Rating = 1 });

            SidecarStore.Save(rawPath, new XmpSidecarDocument { Rating = 5 });
            var loaded = SidecarStore.Load(rawPath);

            Assert.NotNull(loaded);
            Assert.Equal(5, loaded!.Rating);
        }

        [Fact]
        public void SavedFileHasNoUtf8ByteOrderMarkAtTheStreamLevel()
        {
            // The xpacket header carries its own literal U+FEFF inside the
            // `begin` attribute value (docs/xmp-canonical-format.md: "The
            // BOM (U+FEFF) inside xpacket begin is literal — do not strip
            // it"). A UTF-8-with-BOM file encoding would ALSO prepend three
            // BOM bytes before the very first `<`, which is a second,
            // stream-level BOM the format does not call for.
            var rawPath = Path.Combine(_dir, "photo.dng");
            SidecarStore.Save(rawPath, WindowsFixtureModel.BuildDocument());

            var bytes = File.ReadAllBytes(SidecarStore.SidecarPathFor(rawPath));
            Assert.Equal((byte)'<', bytes[0]);
        }
    }
}
