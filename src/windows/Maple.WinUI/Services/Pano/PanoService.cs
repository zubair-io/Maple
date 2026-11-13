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
    /// Spawns `maple-cli pano stitch` (see <see cref="PanoStitchCommand"/>),
    /// streams the CLI's `pano:`-prefixed stderr lines as status, and keeps
    /// the stderr tail for error reporting (the CLI exits 1 with `error: …`).
    /// </summary>
    public sealed partial class PanoService
    {
        public sealed record StitchResult(bool Ok, string? Error, string OutPath, string DisplayPath);

        /// <summary>Run one stitch. `inputs` are the RAW frame paths (the CLI
        /// re-sorts by filename = capture order). Writes the scene-linear
        /// 16-bit master to `outPath` and the sRGB display PNG to
        /// `displayPath`. `alignmentIn` is a preview's solved alignment to
        /// start from (#4581). Progress receives each pano status line.</summary>
        public static async Task<StitchResult> StitchAsync(
            PanoProvisioner provisioner,
            IReadOnlyList<string> inputs,
            string outPath, string displayPath,
            string retention, string localAlign, string strategy,
            PanoFeatureEngine engine, string? alignmentIn,
            Action<string> progress, CancellationToken ct)
        {
            if (provisioner.CliPath is not { } cli)
                return new StitchResult(false, "maple-cli.exe not found.", outPath, displayPath);

            var command = PanoStitchCommand.Build(
                inputs, outPath, displayPath, retention, localAlign, strategy, alignmentIn,
                engine, provisioner.ModelsDir, provisioner.OrtDylibPath);
            var psi = new ProcessStartInfo { FileName = cli };
            foreach (var argument in command.Arguments)
                psi.ArgumentList.Add(argument);
            foreach (var (name, value) in command.Environment)
                psi.Environment[name] = value;

            var exit = await PanoCliProcess.RunAsync(psi, progress, ct);
            if (exit.Cancelled)
                return new StitchResult(false, "cancelled", outPath, displayPath);
            if (exit.ExitCode != 0)
                return new StitchResult(false,
                    $"maple-cli exited {exit.ExitCode}:\n{exit.StderrTail}", outPath, displayPath);
            if (!File.Exists(outPath) || !File.Exists(displayPath))
                return new StitchResult(false,
                    "stitch reported success but did not write both outputs "
                    + $"(master: {File.Exists(outPath)}, display: {File.Exists(displayPath)})",
                    outPath, displayPath);
            return new StitchResult(true, null, outPath, displayPath);
        }
    }
}
