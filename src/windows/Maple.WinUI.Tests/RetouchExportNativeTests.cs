using System.Runtime.CompilerServices;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Export;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class RetouchExportNativeTests
{
    [RetouchNativeFact]
    public async Task SharedCanonicalAndWindowsAuthoredRepairsExportIdenticallyAfterReopen()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        var raw = Environment.GetEnvironmentVariable("MAPLE_RETOUCH_TEST_RAW")!;
        var hash = ExportPaths.Hash(raw);
        var root = Path.Combine(Path.GetTempPath(), "maple-repair-export-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var imported = XmpParser.Parse(XmpRetouchTests.DocWithTwoSpots)!;
            Assert.Equal(2, imported.Adjustments.Retouch.Spots.Count);
            // Author the same shared Swift/TypeScript/Rust canonical spots through
            // Windows commands, without retaining the imported repair XML.
            var authored = XmpParser.Parse(XmpRetouchTests.DocWithTwoSpots)!;
            authored.Adjustments.Retouch = RetouchState.Empty;
            foreach (var entry in imported.Adjustments.Retouch.Spots)
                authored.Adjustments.Retouch = XmpRetouch.Add(authored.Adjustments.Retouch, entry.Spot);
            var saved = XmpWriter.Serialize(authored);
            var reopened = XmpWriter.Serialize(XmpParser.Parse(saved)!);
            var without = XmpParser.Parse(saved)!;
            without.Adjustments.Retouch = RetouchState.Empty;
            var recipe = new ExportRecipe
            {
                SchemaVersion = 1, Name = "Repair parity", Format = "tiff", Quality = null, BitDepth = 16,
                MaxLongEdge = 512, OutputProfile = "srgb", RenderingIntent = "maple-display", MetadataPolicy = "strip",
                NamingTemplate = "{original}.{ext}", Destination = "directory", Directory = root,
                Watermark = null, OverwritePolicy = "error",
            };
            var runner = new ExportQueueRunner(new ExportQueueStore(Path.Combine(root, "ledger")), new NativeExportRecipeExecutor());
            var inputs = new[] { XmpRetouchTests.DocWithTwoSpots, saved, reopened, XmpWriter.Serialize(without) }
                .Select((xml, i) => new ExportInput(raw, xml, "repair-" + i, null)).ToArray();
            var job = runner.Create(recipe, inputs, Array.Empty<string>());
            var result = await runner.RunAsync(job.Id, false, CancellationToken.None);
            Assert.All(result.Entries, entry => Assert.Equal("applied", entry.Status));
            var outputs = result.Entries.Select(entry => File.ReadAllBytes(entry.OutputPath)).ToArray();
            Assert.Equal(outputs[0], outputs[1]);
            Assert.Equal(outputs[1], outputs[2]);
            Assert.False(outputs[0].SequenceEqual(outputs[3]), "Repair export must differ from the unretouched image.");
            Assert.Equal(hash, ExportPaths.Hash(raw));
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
