using System.Runtime.CompilerServices;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Export;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

public sealed class RasterPreviewNativeTests(ITestOutputHelper output)
{
    [Fact]
    public void Tiff_decode_preserves_baked_tone_and_edits_do_not_change_original()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
        {
            output.WriteLine("SKIP-PASS: MAPLE_RAW_FFI_DLL is not set; native preview was not exercised.");
            return;
        }
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var root = Path.Combine(Path.GetTempPath(), "maple-raster-preview-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var path = ExportRasterNativeTests.WriteTiff(root);
            var original = ExportPaths.Hash(path);
            var preview = Path.Combine(root, "preview.jpg");
            var thumbnail = Path.Combine(root, "thumb.avif");
            Assert.Equal(0, RawFfi.maple_render_thumbnail_preview_jpeg_to_file(path, preview, 8, 100));
            Assert.Equal(0, RawFfi.maple_render_thumbnail_avif_to_file(path, thumbnail, 8, 0));
            Assert.True(new FileInfo(thumbnail).Length > 32);
            var model = new AdjustmentState { SharpenAmount = 0, NrColor = 0 };
            var previewImage = RenderEngine.Decode(preview, model, 16, 0, IntPtr.Zero);
            Assert.True(previewImage.IsRaster);
            Assert.Equal(8, previewImage.Width);
            Assert.InRange(previewImage.Pixels[0], 0.049f, 0.054f);
            Assert.Equal(0, RawFfi.maple_render_thumbnail_preview_jpeg_to_file(
                preview, Path.Combine(root, "jpeg-thumb.jpg"), 4, 100));
            var image = RenderEngine.Decode(path, model, 16, 0, IntPtr.Zero);
            Assert.True(image.IsRaster);
            Assert.Equal(16, image.Width);
            Assert.Equal(16, image.Height);
            Assert.True(RenderEngine.DownsampleHalf(image).IsRaster);
            Assert.Equal(2u, MapleGpuLiveParams.From(model, image).input_shape);
            float[]? scratch = null;
            var baseline = new byte[16 * 16 * 4];
            RenderEngine.RenderTick(image, model, ref scratch, baseline);
            // The source stores sRGB 0.25. A second RAW view transform would change it.
            for (var i = 0; i < baseline.Length; i += 4)
            {
                Assert.InRange(baseline[i], (byte)63, (byte)65);
                Assert.InRange(baseline[i + 1], (byte)63, (byte)65);
                Assert.InRange(baseline[i + 2], (byte)63, (byte)65);
                Assert.Equal(255, baseline[i + 3]);
            }
            model.Exposure = 1;
            var edited = new byte[baseline.Length];
            RenderEngine.RenderTick(image, model, ref scratch, edited);
            Assert.True(edited[0] > baseline[0] + 15);
            model.Contrast = 20;
            Assert.Contains("AgX contrast", Assert.Throws<InvalidDataException>(
                () => RenderEngine.ValidateRasterAdjustments(model)).Message);
            Assert.Equal(original, ExportPaths.Hash(path));
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
