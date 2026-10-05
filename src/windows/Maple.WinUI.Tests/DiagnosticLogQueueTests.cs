using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class DiagnosticLogQueueTests
{
    [Fact]
    public async Task StalledStorageAndBurstCannotBlockCallersOrShutdown()
    {
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var writer = new DiagnosticLogQueue(_ => { entered.Set(); release.Wait(); });
        try
        {
            writer.Write("first");
            Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
            var producer = Task.Run(() =>
            {
                for (var index = 0; index < 10000; index++) writer.Write($"burst {index}");
            });
            await producer.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(writer.DroppedCount > 0);
            Assert.False(writer.Shutdown(TimeSpan.FromMilliseconds(50)));
            // Late diagnostics during shutdown remain harmless.
            writer.Write("late");
        }
        finally
        {
            release.Set();
            Assert.True(writer.Shutdown(TimeSpan.FromSeconds(5)));
        }
    }

    [Fact]
    public void RealFileDrainsInOrderAndPreservesExistingRecords()
    {
        var directory = Path.Combine(Path.GetTempPath(), "maple-log-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, "maple.log");
        File.WriteAllText(path, "existing" + Environment.NewLine);
        var writer = new DiagnosticLogQueue(path);
        try
        {
            for (var index = 0; index < 100; index++) writer.Write($"record {index}");
            Assert.True(writer.Shutdown(TimeSpan.FromSeconds(5)));
            Assert.Equal(new[] { "existing" }.Concat(Enumerable.Range(0, 100).Select(i => $"record {i}")),
                File.ReadAllLines(path));
        }
        finally
        {
            writer.Shutdown(TimeSpan.FromSeconds(5));
            Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void WriteFailureDoesNotDisableLaterDiagnostics(bool denied)
    {
        var lines = new List<string>();
        var writer = new DiagnosticLogQueue(message =>
        {
            if (message == "failed")
            {
                if (denied) throw new UnauthorizedAccessException();
                throw new IOException();
            }
            lines.Add(message);
        });
        writer.Write("failed");
        writer.Write("recovered");
        Assert.True(writer.Shutdown(TimeSpan.FromSeconds(5)));
        Assert.Equal(new[] { "recovered" }, lines);
    }
}
