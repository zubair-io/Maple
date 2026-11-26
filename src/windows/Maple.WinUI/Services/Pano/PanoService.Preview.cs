using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Pano
{
    public sealed partial class PanoService
    {
        /// <summary>Run one quick preview (#4581): a ~2048 px sRGB PNG solved
        /// and composited from the proxies, plus the solved alignment the
        /// full stitch can start from. A run carrying seam regions (#5992)
        /// composites with them.</summary>
        public static Task<PanoPreviewOutcome> PreviewAsync(
            PanoProvisioner provisioner, IReadOnlyList<string> inputs, PanoPreviewRun run,
            PanoFeatureEngine engine, Action<string> progress, CancellationToken ct) =>
            provisioner.CliPath is { } cli
                ? PanoCliRuns.PreviewAsync(
                    new PanoCliHost(cli, engine, provisioner.ModelsDir, provisioner.OrtDylibPath),
                    inputs, run, progress, ct)
                : Task.FromResult(new PanoPreviewOutcome(false, false, "maple-cli.exe not found."));
    }
}
