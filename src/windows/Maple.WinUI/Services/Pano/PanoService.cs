using System;
using System.Collections.Generic;
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
        public sealed record StitchResult(
            bool Ok, string? Error, string OutPath, string DisplayPath, string? AlignmentStatus = null);

        /// <summary>Run one stitch. `inputs` are the RAW frame paths (the CLI
        /// re-sorts by filename = capture order). Writes the scene-linear
        /// 16-bit master to `outPath` and the sRGB display PNG to
        /// `displayPath`. `alignmentIn` is a preview's solved alignment to
        /// start from (#4581); `seams` are the regions it must honour
        /// (#5992). Progress receives each pano status line.</summary>
        public static async Task<StitchResult> StitchAsync(
            PanoProvisioner provisioner,
            IReadOnlyList<string> inputs,
            string outPath, string displayPath,
            string retention, string localAlign, string strategy,
            PanoFeatureEngine engine, string? alignmentIn, PanoSeamStitch? seams,
            Action<string> progress, CancellationToken ct)
        {
            if (provisioner.CliPath is not { } cli)
                return new StitchResult(false, "maple-cli.exe not found.", outPath, displayPath);

            var outcome = await PanoCliRuns.StitchAsync(
                new PanoCliHost(cli, engine, provisioner.ModelsDir, provisioner.OrtDylibPath),
                new PanoStitchRun(inputs, outPath, displayPath, retention, localAlign, strategy, alignmentIn, seams),
                progress, ct);
            return new StitchResult(outcome.Ok, outcome.Error, outPath, displayPath, outcome.AlignmentStatus);
        }
    }
}
