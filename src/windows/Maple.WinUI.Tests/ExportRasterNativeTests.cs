using System.Runtime.CompilerServices;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Export;
using Maple.WinUI.Services.Xmp;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

/// <summary>Real DLL + durable Windows queue coverage for #3891. Fixtures are synthetic.</summary>
public sealed class ExportRasterNativeTests(ITestOutputHelper output)
{
    private bool Available()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
        {
            output.WriteLine("SKIP-PASS: MAPLE_RAW_FFI_DLL is not set; raster queue was not exercised.");
            return false;
        }
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        return true;
    }

    private static ExportRecipe Recipe(string root) => new()
    {
        SchemaVersion = 1, Name = "Raster native", Format = "jpeg", Quality = 100, BitDepth = 8,
        MaxLongEdge = null, OutputProfile = "srgb", RenderingIntent = "maple-display",
        MetadataPolicy = "strip", NamingTemplate = "{original}-{n}.{ext}", Destination = "directory",
        Directory = root, Watermark = null, OverwritePolicy = "error",
    };

    private static string Snapshot(double exposure = 0, double contrast = 0) => XmpWriter.Serialize(
        new XmpSidecarDocument { Adjustments = new AdjustmentState
            { Exposure = exposure, Contrast = contrast, SharpenAmount = 0, NrColor = 0 } });

    [Fact]
    public async Task Jpeg_and_tiff_queue_carry_immutable_edits_and_report_unsupported_settings()
    {
        if (!Available()) return;
        var root = Path.Combine(Path.GetTempPath(), "maple-raster-queue-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var source = WriteTiff(root);
            var originalHash = ExportPaths.Hash(source);
            var store = new ExportQueueStore(Path.Combine(root, "ledger"));
            var runner = new ExportQueueRunner(store, new NativeExportRecipeExecutor());
            var recipe = Recipe(root);
            var sourceJob = runner.Create(recipe, [new(source, Snapshot(), "jpeg-source", null)], [source]);
            var created = Assert.Single((await runner.RunAsync(sourceJob.Id, false, CancellationToken.None)).Entries);
            Assert.True(created.Status == "applied", created.Reason);
            var jpeg = created.OutputPath;
            var jpegHash = ExportPaths.Hash(jpeg);
            var jpegPreview = Services.RenderEngine.Decode(jpeg,
                new AdjustmentState { SharpenAmount = 0, NrColor = 0 }, 16, 0, IntPtr.Zero);
            Assert.True(jpegPreview.IsRaster);
            Assert.Equal(16, jpegPreview.Width);
            Assert.Equal(16, jpegPreview.Height);
            var job = runner.Create(recipe, [
                new(source, Snapshot(), "tiff-baseline", null),
                new(source, Snapshot(1), "tiff-edited", null),
                new(jpeg, Snapshot(), "jpeg-baseline", null),
                new(jpeg, Snapshot(1), "jpeg-edited", null),
                new(jpeg, Snapshot(0, 20), "unsupported", null),
            ], [source, jpeg]);
            // Changing the source sidecar after enqueue must not replace the captured edit.
            File.WriteAllText(Path.ChangeExtension(source, ".xmp"), Snapshot(-2));
            var result = await runner.RunAsync(job.Id, false, CancellationToken.None);
            Assert.Equal(new[] { "applied", "applied", "applied", "applied", "failed" },
                result.Entries.Select(item => item.Status));
            Assert.NotEqual(ExportPaths.Hash(result.Entries[0].OutputPath), ExportPaths.Hash(result.Entries[1].OutputPath));
            Assert.NotEqual(ExportPaths.Hash(result.Entries[2].OutputPath), ExportPaths.Hash(result.Entries[3].OutputPath));
            Assert.Contains("AgX contrast", result.Entries[4].Reason);
            Assert.False(File.Exists(result.Entries[4].OutputPath));
            Assert.All(result.Entries, item => Assert.False(File.Exists(item.TempPath)));
            Assert.Equal(originalHash, ExportPaths.Hash(source));
            Assert.Equal(jpegHash, ExportPaths.Hash(jpeg));
            Assert.Equal(result.Entries.Select(item => item.Status), store.Load(job.Id).Entries.Select(item => item.Status));
            output.WriteLine("Real native JPEG/TIFF queues: frozen edits applied, named failure isolated, originals unchanged.");
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact]
    public async Task Cancellation_after_native_render_removes_staging_and_resumes_from_saved_job()
    {
        if (!Available()) return;
        var root = Path.Combine(Path.GetTempPath(), "maple-raster-cancel-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var source = WriteTiff(root);
            var original = ExportPaths.Hash(source);
            var store = new ExportQueueStore(Path.Combine(root, "ledger"));
            using var cancel = new CancellationTokenSource();
            var runner = new ExportQueueRunner(store, new CancelAfterNativeRender(cancel));
            var job = runner.Create(Recipe(root), [new(source, Snapshot(1), "cancelled", null)], [source]);
            var result = await runner.RunAsync(job.Id, false, cancel.Token);
            Assert.True(result.Cancelled);
            var item = Assert.Single(result.Entries);
            Assert.Equal("pending", item.Status);
            Assert.False(File.Exists(item.TempPath));
            Assert.False(File.Exists(item.OutputPath));
            runner = new ExportQueueRunner(new ExportQueueStore(Path.Combine(root, "ledger")), new NativeExportRecipeExecutor());
            var resumed = Assert.Single((await runner.RunAsync(job.Id, false, CancellationToken.None)).Entries);
            Assert.True(resumed.Status == "applied", resumed.Reason);
            Assert.True(File.Exists(resumed.OutputPath));
            Assert.Equal(original, ExportPaths.Hash(source));
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    private sealed class CancelAfterNativeRender(CancellationTokenSource cancellation) : IExportRecipeExecutor
    {
        private readonly NativeExportRecipeExecutor _native = new();
        public void Validate(ExportRecipe recipe) => _native.Validate(recipe);
        public string Filename(ExportRecipe recipe, ExportInput input, ulong index) => _native.Filename(recipe, input, index);
        public void Render(ExportRecipe recipe, ExportQueueItem item)
        {
            _native.Render(recipe, item);
            Assert.True(File.Exists(item.TempPath));
            cancellation.Cancel();
        }
    }

    internal static string WriteTiff(string root)
    {
        // Little-endian 16x16 RGB16 TIFF; 10 IFD entries, bits at 134, pixels at 140.
        var path = Path.Combine(root, "original.tif");
        using var writer = new BinaryWriter(File.Create(path));
        writer.Write(new byte[] { 0x49, 0x49, 42, 0 }); writer.Write(8u); writer.Write((ushort)10);
        void Tag(ushort tag, ushort type, uint count, uint value)
        { writer.Write(tag); writer.Write(type); writer.Write(count); writer.Write(value); }
        Tag(256, 4, 1, 16); Tag(257, 4, 1, 16); Tag(258, 3, 3, 134);
        Tag(259, 3, 1, 1); Tag(262, 3, 1, 2); Tag(273, 4, 1, 140);
        Tag(277, 3, 1, 3); Tag(278, 4, 1, 16); Tag(279, 4, 1, 1536); Tag(284, 3, 1, 1);
        writer.Write(0u);
        for (var channel = 0; channel < 3; channel++) writer.Write((ushort)16);
        for (var sample = 0; sample < 16 * 16 * 3; sample++) writer.Write((ushort)16384);
        return path;
    }
}
