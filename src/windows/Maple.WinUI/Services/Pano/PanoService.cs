using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Pano
{
    /// <summary>
    /// Panorama stitching via the maple-cli subprocess (#2583) — the same
    /// route the Self-Hosted API's pano_stitch job uses, chosen over an FFI
    /// export so a multi-minute, multi-GB stitch lives in its own process.
    /// Spawns `maple-cli pano stitch` with MAPLE_PANO_MODELS/ORT_DYLIB_PATH,
    /// streams the CLI's `pano:`-prefixed stderr lines as status, and keeps
    /// the stderr tail for error reporting (the CLI exits 1 with `error: …`).
    /// </summary>
    public sealed class PanoService
    {
        public sealed record StitchResult(bool Ok, string? Error, string OutPath, string DisplayPath);

        /// <summary>Run one stitch. `inputs` are the RAW frame paths (the CLI
        /// re-sorts by filename = capture order). Writes the scene-linear
        /// 16-bit master to `outPath` and the sRGB display PNG to
        /// `displayPath`. Progress receives each pano status line.</summary>
        public static async Task<StitchResult> StitchAsync(
            PanoProvisioner provisioner,
            IReadOnlyList<string> inputs,
            string outPath, string displayPath,
            string retention, string localAlign, string strategy,
            Action<string> progress, CancellationToken ct)
        {
            if (provisioner.CliPath is not { } cli)
                return new StitchResult(false, "maple-cli.exe not found.", outPath, displayPath);

            var psi = new ProcessStartInfo
            {
                FileName = cli,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
            };
            psi.ArgumentList.Add("pano");
            psi.ArgumentList.Add("stitch");
            psi.ArgumentList.Add("--out");
            psi.ArgumentList.Add(outPath);
            psi.ArgumentList.Add("--display");
            psi.ArgumentList.Add(displayPath);
            psi.ArgumentList.Add("--retention");
            psi.ArgumentList.Add(retention);
            psi.ArgumentList.Add("--local-align");
            psi.ArgumentList.Add(localAlign);
            psi.ArgumentList.Add("--strategy");
            psi.ArgumentList.Add(strategy);
            psi.ArgumentList.Add("--models-dir");
            psi.ArgumentList.Add(provisioner.ModelsDir);
            foreach (var input in inputs)
                psi.ArgumentList.Add(input);
            psi.Environment["MAPLE_PANO_MODELS"] = provisioner.ModelsDir;
            psi.Environment["ORT_DYLIB_PATH"] = provisioner.OrtDylibPath;

            using var process = new Process { StartInfo = psi };
            var stderrTail = new Queue<string>();
            process.ErrorDataReceived += (_, e) =>
            {
                if (string.IsNullOrWhiteSpace(e.Data))
                    return;
                lock (stderrTail)
                {
                    stderrTail.Enqueue(e.Data);
                    while (stderrTail.Count > 12)
                        stderrTail.Dequeue();
                }
                // The CLI's live narration: `pano:` / `pano[tile]:` lines.
                // Everything else on stderr is the report JSON or an error.
                if (e.Data.StartsWith("pano", StringComparison.Ordinal))
                    progress(e.Data);
                DiagLog.Write($"[pano] {e.Data}");
            };

            try
            {
                if (!process.Start())
                    return new StitchResult(false, "failed to start maple-cli", outPath, displayPath);
                process.BeginErrorReadLine();
                process.BeginOutputReadLine();
                await process.WaitForExitAsync(ct);
            }
            catch (OperationCanceledException)
            {
                try { process.Kill(entireProcessTree: true); } catch { /* already gone */ }
                return new StitchResult(false, "cancelled", outPath, displayPath);
            }

            if (process.ExitCode != 0)
            {
                string tail;
                lock (stderrTail)
                {
                    tail = string.Join("\n", stderrTail);
                }
                return new StitchResult(false,
                    $"maple-cli exited {process.ExitCode}:\n{tail}", outPath, displayPath);
            }
            if (!File.Exists(displayPath))
                return new StitchResult(false,
                    "stitch reported success but wrote no display output", outPath, displayPath);
            return new StitchResult(true, null, outPath, displayPath);
        }
    }
}
