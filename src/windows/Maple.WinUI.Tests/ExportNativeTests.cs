using System.Runtime.CompilerServices;
using Maple.WinUI.Generated;
using Maple.WinUI.Services.Export;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

public sealed class ExportNativeTests(ITestOutputHelper output)
{
    private bool Available()
    {
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MAPLE_RAW_FFI_DLL")))
        {
            output.WriteLine("SKIP-PASS: MAPLE_RAW_FFI_DLL not set; native recipe bindings were not exercised.");
            return false;
        }
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        return true;
    }

    private static ExportRecipe Recipe(string directory) => new()
    {
        SchemaVersion = 1, Name = "Native binding", Format = "jpeg", Quality = 92, BitDepth = 8,
        MaxLongEdge = 64, OutputProfile = "display-p3", RenderingIntent = "maple-display", MetadataPolicy = "strip",
        NamingTemplate = "{original}-{date:%Y%m%d}-{n}.{ext}", Destination = "directory", Directory = directory,
        Watermark = null, OverwritePolicy = "error",
    };

    [Fact]
    public void Shared_validation_and_utf8_filenames_use_the_real_c_abi()
    {
        if (!Available()) return;
        var executor = new NativeExportRecipeExecutor();
        var recipe = Recipe(Path.GetTempPath());
        executor.Validate(recipe);
        var filename = executor.Filename(recipe, new("unused.dng", "", "café", "2026:09:06 12:30:00"), 7);
        Assert.Equal("café-20260906-8.jpg", filename);
        Assert.Throws<InvalidDataException>(() => executor.Validate(recipe with { BitDepth = 16 }));
        Assert.Throws<InvalidDataException>(() => executor.Validate(recipe with { Watermark = "unsupported" }));
        // Failure clears on a later valid call on the same thread.
        executor.Validate(recipe);
    }

    [Fact]
    public async Task Native_queue_publishes_a_profiled_jpeg_and_preserves_the_original()
    {
        if (!Available()) return;
        var raw = Environment.GetEnvironmentVariable("MAPLE_EXPORT_TEST_RAW");
        if (string.IsNullOrEmpty(raw))
        {
            output.WriteLine("SKIP-PASS: MAPLE_EXPORT_TEST_RAW not set; fixture export was not exercised.");
            return;
        }
        Assert.True(File.Exists(raw), $"Fixture does not exist: {raw}");
        var root = Path.Combine(Path.GetTempPath(), "maple-native-export-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var originalHash = ExportPaths.Hash(raw);
            var store = new ExportQueueStore(Path.Combine(root, "ledger"));
            var runner = new ExportQueueRunner(store, new NativeExportRecipeExecutor());
            var job = runner.Create(Recipe(root), new[]
            {
                new ExportInput(raw, ExportSnapshot.Serialize(null), "native", "2026:09:06 12:30:00"),
            }, Array.Empty<string>());
            var result = await runner.RunAsync(job.Id, false, CancellationToken.None);
            Assert.Equal("applied", result.Entries[0].Status);
            var bytes = File.ReadAllBytes(result.Entries[0].OutputPath);
            Assert.Equal(new byte[] { 0xff, 0xd8 }, bytes[..2]);
            Assert.Contains("ICC_PROFILE", System.Text.Encoding.Latin1.GetString(bytes));
            Assert.Equal(originalHash, ExportPaths.Hash(raw));
            Assert.False(File.Exists(result.Entries[0].TempPath));
            Assert.Equal("applied", store.Load(job.Id).Entries[0].Status);
            output.WriteLine($"Actual native export: {bytes.Length} bytes, ICC present, original SHA256 unchanged.");

            const string filmId = "black_white_ilford_delta_100";
            Assert.True(File.Exists(Path.Combine(AppContext.BaseDirectory, "film-luts", filmId + ".mlut")),
                "The shared app/test packaging must copy the actual film LUT payload.");
            var filmXmp = "<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">" +
                "<rdf:Description xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" papp:FilmLook=\"" +
                filmId + "\" papp:FilmStrength=\"100\"/></rdf:RDF>";
            var filmJob = runner.Create(Recipe(root), new[]
            {
                new ExportInput(raw, filmXmp, "with-film", "2026:09:06 12:30:00"),
            }, Array.Empty<string>());
            var filmResult = await runner.RunAsync(filmJob.Id, false, CancellationToken.None);
            Assert.Equal("applied", filmResult.Entries[0].Status);
            var filmBytes = File.ReadAllBytes(filmResult.Entries[0].OutputPath);
            Assert.False(bytes.SequenceEqual(filmBytes), "The captured film look must affect actual output pixels.");
            Assert.Contains("ICC_PROFILE", System.Text.Encoding.Latin1.GetString(filmBytes));
            Assert.Equal(originalHash, ExportPaths.Hash(raw));
            output.WriteLine($"Actual bundled {filmId} export: {filmBytes.Length} bytes; differs from the no-film output.");
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
