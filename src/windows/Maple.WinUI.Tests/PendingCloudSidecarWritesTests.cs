using Maple.WinUI.Services.Cloud;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class PendingCloudSidecarWritesTests
{
    [Fact]
    public async Task FailureRetainsOrderAndRetrySkipsAlreadyAcknowledgedWrites()
    {
        var queue = new PendingCloudSidecarWrites();
        var attempts = new List<int>();
        var fail = true;
        queue.Enqueue(() => { attempts.Add(1); return Task.CompletedTask; });
        queue.Enqueue(() =>
        {
            attempts.Add(2);
            return fail ? Task.FromException(new IOException("Read-only")) : Task.CompletedTask;
        });
        queue.Enqueue(() => { attempts.Add(3); return Task.CompletedTask; });
        var error = await Assert.ThrowsAsync<InvalidOperationException>(() => queue.DrainAsync());
        Assert.Contains("Read-only", error.Message);
        Assert.Equal(new[] { 1, 2 }, attempts);
        // Reading a failed queue does not silently retry or drop it.
        await Assert.ThrowsAsync<InvalidOperationException>(() => queue.DrainAsync());
        Assert.Equal(new[] { 1, 2 }, attempts);
        fail = false;
        await queue.DrainAsync(retryFailed: true);
        Assert.Equal(new[] { 1, 2, 2, 3 }, attempts);
    }

    [Fact]
    public async Task DrainWaitsForAcknowledgementAndQueuedSuccessors()
    {
        var queue = new PendingCloudSidecarWrites();
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var successor = false;
        queue.Enqueue(async () => { started.SetResult(); await release.Task; });
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        queue.Enqueue(() => { successor = true; return Task.CompletedTask; });
        var drain = queue.DrainAsync();
        Assert.False(drain.IsCompleted);
        Assert.False(successor);
        release.SetResult();
        await drain.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(successor);
    }

    [Fact]
    public async Task EnqueueAfterIdleStartsANewWorker()
    {
        var queue = new PendingCloudSidecarWrites();
        var saves = 0;
        for (var i = 0; i < 50; i++)
        {
            queue.Enqueue(() => { saves++; return Task.CompletedTask; });
            await queue.DrainAsync().WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(i + 1, saves);
        }
    }
}
