using System.Text.Json.Nodes;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Transfer;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class LocalTransferJobTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "maple-transfer-" + Guid.NewGuid().ToString("N"));
    public LocalTransferJobTests() => Directory.CreateDirectory(_root);
    public void Dispose() => Directory.Delete(_root, true);
    private sealed class Progress(Action<TransferJobProgress> action) : IProgress<TransferJobProgress>
    { public void Report(TransferJobProgress value) => action(value); }

    private TransferJobInput Input(int index)
    {
        var path = Path.Combine(_root, index + ".dng");
        File.WriteAllText(path, "original sentinel " + index);
        var doc = new XmpSidecarDocument { Rating = 4, Adjustments = new() { Saturation = 17 } };
        doc.PassthroughNamespaces.Add(new("vendor", "urn:vendor"));
        doc.PassthroughAttributes.Add(new("vendor:preserve", "yes"));
        SidecarStore.Save(path, doc);
        var patch = AdjustmentTransfer.Build(new(new AdjustmentState { Exposure = 1.5 }, 5, null), new[] { "tone" });
        return new(path, Path.GetFileName(path), SidecarStore.SnapshotHash(SidecarStore.ReadSnapshot(path)), patch);
    }

    [Fact]
    public async Task UndoAcknowledgementRejectsFailedAndSupersededWrites()
    {
        var input = Input(0);
        var job = await LocalTransferJob.CreateAsync(_root, new[] { input });
        Assert.False(await job.IsCurrentAppliedAsync(input.Path));
        await job.RunAsync(false, CancellationToken.None);
        Assert.True(await job.IsCurrentAppliedAsync(input.Path));
        await File.AppendAllTextAsync(SidecarStore.SidecarPathFor(input.Path), "\n");
        Assert.False(await job.IsCurrentAppliedAsync(input.Path));
        var stale = await LocalTransferJob.CreateAsync(_root, new[] { input });
        var failed = await stale.RunAsync(false, CancellationToken.None);
        Assert.Single(failed.Failures);
        Assert.False(await stale.IsCurrentAppliedAsync(input.Path));
    }

    [Fact]
    public async Task CancelStopsAfterInFlightWriteAndRestartResumesOnlyPending()
    {
        var inputs = Enumerable.Range(0, 3).Select(Input).ToArray();
        var job = await LocalTransferJob.CreateAsync(_root, inputs);
        using var cancel = new CancellationTokenSource();
        var first = await job.RunAsync(false, cancel.Token, new Progress(p =>
        {
            Assert.Equal(1, p.Applied);
            Assert.Equal(2, p.Pending);
            cancel.Cancel();
        }));
        Assert.True(first.Cancelled);
        Assert.Equal(1, first.Applied);
        Assert.Equal(2, first.Pending);
        var firstWrite = File.GetLastWriteTimeUtc(SidecarStore.SidecarPathFor(inputs[0].Path));
        var reopened = await LocalTransferJob.OpenAsync(_root, job.Id);
        var done = await reopened.RunAsync(false, CancellationToken.None);
        Assert.Equal(3, done.Applied);
        Assert.Equal(0, done.Pending);
        Assert.Empty(done.Failures);
        Assert.Equal(firstWrite, File.GetLastWriteTimeUtc(SidecarStore.SidecarPathFor(inputs[0].Path)));
        for (var i = 0; i < inputs.Length; i++)
        {
            Assert.Equal("original sentinel " + i, File.ReadAllText(inputs[i].Path));
            var doc = SidecarStore.Load(inputs[i].Path)!;
            Assert.Equal(1.5, doc.Adjustments.Exposure);
            Assert.Equal(17, doc.Adjustments.Saturation);
            Assert.Equal(4, doc.Rating);
            Assert.Contains(doc.PassthroughAttributes, a => a.Name == "vendor:preserve" && a.Value == "yes");
        }
    }

    [Fact]
    public async Task PreparedRecoveryAcknowledgesMatchingWriteAndRejectsNewerEdit()
    {
        var inputs = Enumerable.Range(0, 3).Select(Input).ToArray();
        var job = await LocalTransferJob.CreateAsync(_root, inputs);
        await job.RunAsync(false, CancellationToken.None);
        // Model a process exit after sidecar rename, before applied checkpoint.
        for (var i = 0; i < 3; i++)
        {
            var path = Path.Combine(_root, job.Id, i.ToString("D8") + ".json");
            var item = JsonNode.Parse(await File.ReadAllTextAsync(path))!;
            Assert.NotNull(item["Before"]);
            Assert.NotNull(item["After"]);
            item["Status"] = "prepared";
            await File.WriteAllTextAsync(path, item.ToJsonString());
            // Third target models interruption before its sidecar rename.
            if (i == 2) await File.WriteAllBytesAsync(SidecarStore.SidecarPathFor(inputs[i].Path),
                Convert.FromBase64String(item["Before"]!.GetValue<string>()));
        }
        SidecarStore.Update(inputs[1].Path, doc => doc.Adjustments.Exposure = 3);
        var sameWrite = File.GetLastWriteTimeUtc(SidecarStore.SidecarPathFor(inputs[0].Path));
        var reopened = await LocalTransferJob.OpenAsync(_root, job.Id);
        var result = await reopened.RunAsync(false, CancellationToken.None);
        Assert.Equal(2, result.Applied);
        Assert.Equal(1.5, SidecarStore.Load(inputs[2].Path)!.Adjustments.Exposure);
        Assert.Equal(inputs[1].Path, Assert.Single(result.Failures).Path);
        Assert.Equal(sameWrite, File.GetLastWriteTimeUtc(SidecarStore.SidecarPathFor(inputs[0].Path)));
        Assert.Equal(3, SidecarStore.Load(inputs[1].Path)!.Adjustments.Exposure);
        var retry = await reopened.RunAsync(true, CancellationToken.None);
        Assert.Single(retry.Failures);
        Assert.Equal(3, SidecarStore.Load(inputs[1].Path)!.Adjustments.Exposure);
    }

    [Fact]
    public async Task RetryFailuresDoesNotConsumePendingTargetsOrReplacePreviewConflicts()
    {
        var inputs = Enumerable.Range(0, 3).Select(Input).ToArray();
        var job = await LocalTransferJob.CreateAsync(_root, inputs);
        SidecarStore.Update(inputs[0].Path, doc => doc.Adjustments.Exposure = 2);
        using var cancel = new CancellationTokenSource();
        var first = await job.RunAsync(false, cancel.Token, new Progress(_ => cancel.Cancel()));
        Assert.Single(first.Failures);
        var retry = await job.RunAsync(true, CancellationToken.None);
        Assert.Equal(2, retry.Pending);
        Assert.Single(retry.Failures);
        Assert.Equal(0, SidecarStore.Load(inputs[1].Path)!.Adjustments.Exposure);
        Assert.Equal(2, SidecarStore.Load(inputs[0].Path)!.Adjustments.Exposure);
    }

    [Fact]
    public async Task SharedSidecarAndOriginalXmpTargetsAreRejected()
    {
        var input = Input(0);
        await Assert.ThrowsAsync<InvalidDataException>(() => LocalTransferJob.CreateAsync(_root,
            new[] { input, input with { Path = Path.ChangeExtension(input.Path, ".jpg") } }));
        await Assert.ThrowsAsync<InvalidDataException>(() => LocalTransferJob.CreateAsync(_root,
            new[] { input with { Path = Path.ChangeExtension(input.Path, ".xmp") } }));
    }

    [Fact]
    public async Task ATransientReadFailureCanBeRetriedWithoutReplayingSuccesses()
    {
        var inputs = Enumerable.Range(0, 2).Select(Input).ToArray();
        var job = await LocalTransferJob.CreateAsync(_root, inputs);
        using (var locked = new FileStream(SidecarStore.SidecarPathFor(inputs[0].Path), FileMode.Open, FileAccess.Read, FileShare.None))
        {
            var first = await job.RunAsync(false, CancellationToken.None);
            Assert.Equal(1, first.Applied);
            Assert.Equal(inputs[0].Name, Assert.Single(first.Failures).Name);
        }
        var timestamp = File.GetLastWriteTimeUtc(SidecarStore.SidecarPathFor(inputs[1].Path));
        var reopened = await LocalTransferJob.OpenAsync(_root, job.Id);
        var retried = await reopened.RunAsync(true, CancellationToken.None);
        Assert.Equal(2, retried.Applied);
        Assert.Empty(retried.Failures);
        Assert.Equal(timestamp, File.GetLastWriteTimeUtc(SidecarStore.SidecarPathFor(inputs[1].Path)));
    }
}
