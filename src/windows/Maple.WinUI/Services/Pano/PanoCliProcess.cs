using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Pano;

public sealed record PanoCliExit(bool Cancelled, int ExitCode, string StderrTail);

/// <summary>Runs one maple-cli pano process: streams its `pano`-prefixed
/// stderr lines (the CLI's live narration; everything else there is the
/// report JSON or an error) and keeps the stderr tail for error reporting.
/// Cancelling kills the process tree.</summary>
public static class PanoCliProcess
{
    private const int TailLines = 12;

    public static async Task<PanoCliExit> RunAsync(
        ProcessStartInfo psi, Action<string> onPanoLine, CancellationToken ct)
    {
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardError = true;
        psi.RedirectStandardOutput = true;

        using var process = new Process { StartInfo = psi };
        var stderrTail = new Queue<string>();
        process.ErrorDataReceived += (_, e) =>
        {
            if (string.IsNullOrWhiteSpace(e.Data))
                return;
            lock (stderrTail)
            {
                stderrTail.Enqueue(e.Data);
                while (stderrTail.Count > TailLines)
                    stderrTail.Dequeue();
            }
            if (e.Data.StartsWith("pano", StringComparison.Ordinal))
                onPanoLine(e.Data);
            DiagLog.Write($"[pano] {e.Data}");
        };

        try
        {
            if (!process.Start())
                return new PanoCliExit(false, -1, "failed to start maple-cli");
            process.BeginErrorReadLine();
            process.BeginOutputReadLine();
            await process.WaitForExitAsync(ct);
            // WaitForExitAsync does not drain the async stream readers; the
            // parameterless synchronous wait does, so the tail is complete.
            process.WaitForExit();
        }
        catch (OperationCanceledException)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
                DiagLog.Write($"[pano] kill after cancel: {ex.Message}");
            }
            return new PanoCliExit(true, -1, "cancelled");
        }

        lock (stderrTail)
        {
            return new PanoCliExit(false, process.ExitCode, string.Join("\n", stderrTail));
        }
    }
}
