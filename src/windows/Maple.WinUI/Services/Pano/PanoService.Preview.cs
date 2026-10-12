using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Pano
{
    public sealed partial class PanoService
    {
        /// <summary>Run one quick preview (#4581): a ~2048 px sRGB PNG solved
        /// and composited from the proxies, plus the solved alignment the
        /// full stitch can start from.</summary>
        public static async Task<PanoPreviewOutcome> PreviewAsync(
            PanoProvisioner provisioner, IReadOnlyList<string> inputs,
            PanoPreviewFiles files, string? alignmentIn, PanoPreviewOptions options,
            Action<string> progress, CancellationToken ct)
        {
            if (provisioner.CliPath is not { } cli)
                return new PanoPreviewOutcome(false, false, "maple-cli.exe not found.");

            var command = PanoPreviewCommand.Build(inputs, files, alignmentIn, options, provisioner.ModelsDir);
            var psi = new ProcessStartInfo { FileName = cli };
            foreach (var argument in command.Arguments)
                psi.ArgumentList.Add(argument);
            psi.Environment["MAPLE_PANO_MODELS"] = provisioner.ModelsDir;
            psi.Environment["ORT_DYLIB_PATH"] = provisioner.OrtDylibPath;

            var exit = await PanoCliProcess.RunAsync(psi, progress, ct);
            return exit switch
            {
                { Cancelled: true } => new PanoPreviewOutcome(false, true, null),
                { ExitCode: not 0 } => new PanoPreviewOutcome(false, false,
                    $"maple-cli exited {exit.ExitCode}:\n{exit.StderrTail}"),
                _ when !File.Exists(files.PreviewPng) || !File.Exists(files.AlignmentJson) =>
                    new PanoPreviewOutcome(false, false,
                        "preview reported success but did not write the image and alignment"),
                _ => new PanoPreviewOutcome(true, false, null),
            };
        }
    }
}
