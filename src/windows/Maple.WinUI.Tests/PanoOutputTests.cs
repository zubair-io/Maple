using System.Diagnostics;
using Maple.WinUI.Services.Pano;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class PanoOutputTests : IDisposable
{
    private readonly string _folder = Path.Combine(Path.GetTempPath(), "maple-pano-output-test-" + Guid.NewGuid().ToString("N"));

    public PanoOutputTests() => Directory.CreateDirectory(_folder);

    public void Dispose() => Directory.Delete(_folder, recursive: true);

    [Fact]
    public void AFreeNameIsKept() =>
        Assert.Equal("a-pano", PanoOutputFiles.UniqueBaseName(_folder, "a-pano"));

    [Theory]
    [InlineData("a-pano-master.png")]
    [InlineData("a-pano.jpg")]
    public void ANameWhoseOutputAlreadyExistsGetsTheNextNumber(string existing)
    {
        File.WriteAllText(Path.Combine(_folder, existing), "yours");
        File.WriteAllText(Path.Combine(_folder, "a-pano-2.jpg"), "yours");

        Assert.Equal("a-pano-3", PanoOutputFiles.UniqueBaseName(_folder, "a-pano"));
    }

    [Fact]
    public void DiscardingAFailedRunsMasterNeverTouchesAnEarlierPanoramaOfTheSameName()
    {
        var earlier = PanoOutputFiles.MasterPath(_folder, "a-pano");
        File.WriteAllText(earlier, "an earlier panorama");
        var baseName = PanoOutputFiles.UniqueBaseName(_folder, "a-pano");
        var created = PanoOutputFiles.MasterPath(_folder, baseName);
        File.WriteAllText(created, "partial");

        Assert.Null(PanoOutputFiles.DiscardPartial(created));

        Assert.Equal("a-pano-2", baseName);
        Assert.False(File.Exists(created));
        Assert.Equal("an earlier panorama", File.ReadAllText(earlier));
    }

    [Fact]
    public void AMasterThatCannotBeRemovedIsReportedNotSwallowed()
    {
        var locked = PanoOutputFiles.MasterPath(_folder, "held");
        using var held = new FileStream(locked, FileMode.Create, FileAccess.ReadWrite, FileShare.None);
        if (!OperatingSystem.IsWindows())
        {
            Directory.CreateDirectory(Path.Combine(_folder, "dir-master.png"));
            locked = Path.Combine(_folder, "dir-master.png");
            File.WriteAllText(Path.Combine(locked, "inside"), "x");
        }

        Assert.NotNull(PanoOutputFiles.DiscardPartial(locked));
    }

    [Fact]
    public async Task CancellingWaitsUntilTheProcessHasExited()
    {
        var pidFile = Path.Combine(_folder, "pid.txt");
        var psi = OperatingSystem.IsWindows()
            ? new ProcessStartInfo("powershell.exe")
            {
                ArgumentList = { "-NoProfile", "-Command", $"Set-Content -Path '{pidFile}' -Value $PID; Start-Sleep 60" },
            }
            : new ProcessStartInfo("/bin/sh") { ArgumentList = { "-c", $"echo $$ > '{pidFile}'; exec sleep 60" } };
        using var cancel = new CancellationTokenSource();
        var running = PanoCliProcess.RunAsync(psi, _ => { }, cancel.Token);
        for (var waited = 0; !File.Exists(pidFile) && waited < 100; waited++)
            await Task.Delay(100);
        Assert.True(File.Exists(pidFile), "the child never started");
        await Task.Delay(200);
        var pid = int.Parse((await File.ReadAllTextAsync(pidFile)).Trim());

        cancel.Cancel();
        var exit = await running;

        Assert.True(exit.Cancelled);
        Assert.Throws<ArgumentException>(() => Process.GetProcessById(pid));
    }
}
