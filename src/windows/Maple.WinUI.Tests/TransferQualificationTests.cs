using System.Diagnostics;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Transfer;
using Maple.WinUI.Services.Xmp;
using Xunit;
using Xunit.Abstractions;

namespace Maple.WinUI.Tests;

public sealed class TransferQualificationTests(ITestOutputHelper output)
{
    private sealed class Progress(Action<TransferJobProgress> action) : IProgress<TransferJobProgress>
    { public void Report(TransferJobProgress value) => action(value); }

    [Fact]
    [Trait("Category", "Qualification")]
    public async Task TwoThousandRealSidecarsCompleteWithExactProgressAndUnchangedOriginals()
    {
        var root = Path.Combine(Path.GetTempPath(), "maple-transfer-2000-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var patch = AdjustmentTransfer.Build(new(new AdjustmentState { Exposure = 1.25 }, 5, null), new[] { "tone" });
            var inputs = new TransferJobInput[2000];
            for (var i = 0; i < inputs.Length; i++)
            {
                var path = Path.Combine(root, i + ".dng");
                await File.WriteAllTextAsync(path, "unchanged original " + i);
                SidecarStore.Save(path, new XmpSidecarDocument { Rating = 3, Adjustments = new() { Saturation = 17 } });
                inputs[i] = new(path, Path.GetFileName(path), SidecarStore.SnapshotHash(SidecarStore.ReadSnapshot(path)), patch);
            }
            // Fixture construction is outside the measured region; job creation,
            // durable preparation, sidecar rename and acknowledgement are included.
            using var process = Process.GetCurrentProcess();
            process.Refresh();
            var initialRss = process.WorkingSet64;
            var peakRss = initialRss;
            var timer = Stopwatch.StartNew();
            var job = await LocalTransferJob.CreateAsync(Path.Combine(root, "jobs"), inputs);
            var observed = 0;
            var result = await job.RunAsync(false, CancellationToken.None, new Progress(p =>
            {
                observed++;
                Assert.Equal(observed, p.Applied);
                Assert.Equal(2000 - observed, p.Pending);
                Assert.Equal(0, p.Failed);
                if (observed % 32 == 0)
                {
                    process.Refresh();
                    peakRss = Math.Max(peakRss, process.WorkingSet64);
                }
            }));
            timer.Stop();
            process.Refresh();
            peakRss = Math.Max(peakRss, process.WorkingSet64);
            output.WriteLine($"2000-sidecar local transfer: elapsed_ms={timer.ElapsedMilliseconds}, initial_rss_bytes={initialRss}, sampled_peak_rss_bytes={peakRss}, processors={Environment.ProcessorCount}, os={Environment.OSVersion}, runtime={Environment.Version}");
            Assert.Equal(2000, result.Applied);
            Assert.Equal(2000, observed);
            Assert.Empty(result.Failures);
            Assert.Equal(0, result.Pending);
            for (var i = 0; i < inputs.Length; i++)
            {
                Assert.Equal("unchanged original " + i, await File.ReadAllTextAsync(inputs[i].Path));
                var doc = SidecarStore.Load(inputs[i].Path)!;
                Assert.Equal(1.25, doc.Adjustments.Exposure);
                Assert.Equal(17, doc.Adjustments.Saturation);
                Assert.Equal(3, doc.Rating);
            }
        }
        finally { Directory.Delete(root, true); }
    }
}
