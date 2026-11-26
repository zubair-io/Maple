using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
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
    private static readonly TimeSpan ExitGrace = TimeSpan.FromSeconds(15);

    public static async Task<PanoCliExit> RunAsync(
        ProcessStartInfo psi, Action<string> onPanoLine, CancellationToken ct)
    {
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardError = true;
        psi.RedirectStandardOutput = true;
        // The CLI writes UTF-8; the console code page would mangle the dash
        // in its alignment line and every non-ASCII path in its errors.
        psi.StandardOutputEncoding = new UTF8Encoding(false);
        psi.StandardErrorEncoding = new UTF8Encoding(false);

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
            await KillAndWaitAsync(process);
            return new PanoCliExit(true, -1, "cancelled");
        }

        lock (stderrTail)
        {
            return new PanoCliExit(false, process.ExitCode, string.Join("\n", stderrTail));
        }
    }

    // A killed CLI can still hold its output files for a moment; callers
    // delete what the run wrote, so wait until it has really gone.
    private static async Task KillAndWaitAsync(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            DiagLog.Write($"[pano] kill after cancel: {ex.Message}");
        }
        try
        {
            using var grace = new CancellationTokenSource(ExitGrace);
            await process.WaitForExitAsync(grace.Token);
        }
        catch (OperationCanceledException)
        {
            DiagLog.Write($"[pano] maple-cli was still running {ExitGrace.TotalSeconds:0} s after it was killed");
        }
        catch (InvalidOperationException ex)
        {
            DiagLog.Write($"[pano] wait after cancel: {ex.Message}");
        }
    }
}
