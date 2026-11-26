using System.Runtime.CompilerServices;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Export;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

[Collection(Bench.CollectionName)]
[Trait("Category", "Benchmark")]
public sealed class NativePhotoBenchmarks(SyntheticPhotoFixture photo, ITestOutputHelper output)
{
    private const int Rounds = 5;
    private const int TicksPerRound = 20;
    private const int OpenLongEdge = 1600;

    private static string Description =>
        $"synthetic {SyntheticPhotoFixture.Width}x{SyntheticPhotoFixture.Height} uncompressed 16-bit RGGB DNG (no decompression cost, no embedded preview so the Auto profile has none to fit) "
        + $"({SyntheticPhotoFixture.Width * SyntheticPhotoFixture.Height / 1_000_000} MP), cores {Environment.ProcessorCount}";

    [BenchmarkFact(native: true)]
    public void Editor_open_and_cpu_slider_tick_of_the_decoded_photo()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        Bench.Line(output, $"W15 native call measured from C# (RenderEngine.Decode and RenderEngine.RenderTick, the calls the app makes; not the app, no GPU present): {Description}");
        RenderEngine.Decode(photo.Path, new AdjustmentState(), OpenLongEdge, RefineDecodeQuality.Preview, IntPtr.Zero);

        var decoded = new List<DecodedImage>();
        var opens = Enumerable.Range(0, Rounds).Select(_ => Bench.Measure(() =>
            decoded.Add(RenderEngine.Decode(photo.Path, new AdjustmentState(), OpenLongEdge, RefineDecodeQuality.Preview, IntPtr.Zero)))).ToArray();
        Bench.Stats(output, $"W15 open: decode to a {decoded[0].Width}x{decoded[0].Height} f32 base, rounds", opens);

        var image = decoded[0];
        var model = new AdjustmentState();
        var scratch = (float[]?)null;
        var bgra = new byte[image.Width * image.Height * 4];
        RenderEngine.RenderTick(image, model, ref scratch, bgra);
        var roundMedians = new List<double>();
        var ticks = new List<double>();
        for (var round = 0; round < Rounds; round++)
        {
            var roundTicks = Enumerable.Range(0, TicksPerRound).Select(index =>
            {
                model.Exposure = index % 2 == 0 ? 0.01 : -0.01;
                return Bench.Measure(() => RenderEngine.RenderTick(image, model, ref scratch, bgra));
            }).ToArray();
            ticks.AddRange(roundTicks);
            roundMedians.Add(roundTicks.Order().ElementAt(TicksPerRound / 2));
        }
        Bench.Stats(output, "W15 CPU-fallback tick (RenderTick incl. BGRA conversion), all ticks", ticks);
        Bench.Stats(output, "W15 CPU-fallback tick, per-round medians", roundMedians);
        Assert.Equal(Rounds * TicksPerRound, ticks.Count);
    }

    [BenchmarkFact(native: true)]
    public async Task Default_jpeg_export_of_the_photo_through_the_export_queue()
    {
        RuntimeHelpers.RunClassConstructor(typeof(RawFfiLayoutTests).TypeHandle);
        Bench.Line(output, $"W16 export through ExportQueueRunner with NativeExportRecipeExecutor (the app's queue path); default recipe JPEG q92 full size sRGB: {Description}");
        var root = Path.Combine(Path.GetTempPath(), "maple-bench-export-" + Guid.NewGuid().ToString("N"));
        try
        {
            var totals = new List<double>();
            var natives = new List<double>();
            for (var round = 0; round <= Rounds; round++)
            {
                var directory = Path.Combine(root, $"round-{round}");
                Directory.CreateDirectory(directory);
                var executor = new TimedExecutor(new NativeExportRecipeExecutor());
                var runner = new ExportQueueRunner(new ExportQueueStore(Path.Combine(directory, "ledger")), executor);
                var recipe = new ExportRecipe
                {
                    SchemaVersion = 1, Name = "JPEG sharing", Format = "jpeg", Quality = 92, BitDepth = 8,
                    MaxLongEdge = null, OutputProfile = "srgb", RenderingIntent = "maple-display", MetadataPolicy = "strip",
                    NamingTemplate = "{original}-{n}.{ext}", Destination = "directory", Directory = directory,
                    Watermark = null, OverwritePolicy = "error",
                };
                var input = new ExportInput(photo.Path, ExportSnapshot.Serialize(null), "photo-24mp", "2026:09:06 12:30:00");
                var total = await Bench.MeasureAsync(async () =>
                {
                    var job = runner.Create(recipe, new[] { input }, new[] { photo.Path });
                    var result = await runner.RunAsync(job.Id, false, CancellationToken.None);
                    Assert.Equal("applied", result.Entries[0].Status);
                });
                if (round == 0) continue;
                totals.Add(total);
                natives.Add(executor.RenderMilliseconds);
            }
            Bench.Stats(output, "W16 export, queue create + run (hash, native encode, publish), rounds", totals);
            Bench.Stats(output, "W16 export, native maple_export_recipe_to_file call alone, rounds", natives);
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    private sealed class TimedExecutor(IExportRecipeExecutor inner) : IExportRecipeExecutor
    {
        public double RenderMilliseconds { get; private set; }
        public void Validate(ExportRecipe recipe) => inner.Validate(recipe);
        public string Filename(ExportRecipe recipe, ExportInput input, ulong index) => inner.Filename(recipe, input, index);
        public void Render(ExportRecipe recipe, ExportQueueItem item) =>
            RenderMilliseconds = Bench.Measure(() => inner.Render(recipe, item));
    }
}
