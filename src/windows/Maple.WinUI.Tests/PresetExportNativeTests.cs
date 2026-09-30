using System.Runtime.CompilerServices;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Export;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class PresetExportNativeFactAttribute : FactAttribute
{
    public PresetExportNativeFactAttribute()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL"))
            || string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_EXPORT_TEST_RAW")))
            Skip = "Requires MAPLE_RAW_FFI_DLL and MAPLE_EXPORT_TEST_RAW for real preset export qualification.";
    }
}

public sealed class PresetExportNativeTests
{
    [PresetExportNativeFact]
    public async Task SparsePresetExportsIdenticallyAfterDiskReopenAndResetRestoresBaseline()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var source = Environment.GetEnvironmentVariable("MAPLE_EXPORT_TEST_RAW")!;
        var originalHash = ExportPaths.Hash(source);
        var root = Path.Combine(Path.GetTempPath(), "maple-preset-export-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var raw = Path.Combine(root, Path.GetFileName(source));
            File.Copy(source, raw);
            var baseline = new AdjustmentState { Exposure = .75 };
            var preset = PresetDocument.Parse("""
                {"schemaVersion":1,"name":"Export check","fields":{"contrast":-43,"saturation":-29,"future_field":true}}
                """);
            var applied = AdjustmentFieldBridge.Apply(baseline, preset.Fields);
            Assert.Equal(new[] { "future_field" }, applied.Skipped);
            var live = ExportSnapshot.Serialize(null, applied.State);
            SidecarStore.Save(raw, XmpParser.Parse(live)!);
            var reopened = SidecarStore.Load(raw);
            Assert.NotNull(reopened);
            Assert.Equal(.75, reopened.Adjustments.Exposure);
            var reset = AdjustmentFieldBridge.Apply(reopened.Adjustments,
                AdjustmentFieldBridge.DefaultsFor(preset.Fields.Keys));
            Assert.Equal(.75, reset.State.Exposure);
            var inputs = new[]
            {
                ExportSnapshot.Serialize(null, baseline), live,
                ExportSnapshot.Serialize(XmpWriter.Serialize(reopened)),
                ExportSnapshot.Serialize(null, reset.State),
            }.Select((xml, i) => new ExportInput(raw, xml, "preset-" + i, null)).ToArray();
            var recipe = new ExportRecipe
            {
                SchemaVersion = 1, Name = "Preset persistence", Format = "tiff", BitDepth = 16, Quality = null,
                MaxLongEdge = 512, OutputProfile = "srgb", RenderingIntent = "maple-display",
                MetadataPolicy = "strip", NamingTemplate = "{original}.{ext}",
                Destination = "directory", Directory = root, OverwritePolicy = "error", Watermark = null,
            };
            var runner = new ExportQueueRunner(new ExportQueueStore(Path.Combine(root, "ledger")),
                new NativeExportRecipeExecutor());
            var job = runner.Create(recipe, inputs, Array.Empty<string>());
            var result = await runner.RunAsync(job.Id, false, CancellationToken.None);
            Assert.All(result.Entries, entry => Assert.Equal("applied", entry.Status));
            var outputs = result.Entries.Select(entry => File.ReadAllBytes(entry.OutputPath)).ToArray();
            Assert.False(outputs[0].SequenceEqual(outputs[1]), "Applying the preset must change rendered output.");
            Assert.Equal(outputs[1], outputs[2]);
            Assert.Equal(outputs[0], outputs[3]);
            Assert.Equal(originalHash, ExportPaths.Hash(source));
            Assert.Equal(originalHash, ExportPaths.Hash(raw));
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
