using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services.Pano;

public sealed record PanoCliHost(string CliPath, PanoFeatureEngine Engine, string ModelsDir, string OrtDylibPath);

public sealed record PanoStitchRun(
    IReadOnlyList<string> Inputs, string OutPath, string DisplayPath,
    string Retention, string LocalAlign, string Strategy, string? AlignmentIn, PanoSeamStitch? Seams);

/// <summary>`AlignmentStatus` is read from the stitch report, which only a
/// run carrying seam regions asks for; null otherwise.</summary>
public sealed record PanoStitchOutcome(bool Ok, bool Cancelled, string? Error, string? AlignmentStatus = null);

/// <summary>One maple-cli preview or stitch from start to verdict: write
/// the seam request file when the run carries regions, run the process, and
/// read back what it reported. A run with regions only counts as done when
/// the report echoes exactly the request that was sent (#5992).</summary>
public static class PanoCliRuns
{
    public const string UnconfirmedSeams =
        PanoCliReport.InvalidSeamConstraints + ": maple-cli did not confirm the requested seam regions.";

    public static async Task<PanoPreviewOutcome> PreviewAsync(
        PanoCliHost host, IReadOnlyList<string> inputs, PanoPreviewRun run,
        Action<string> progress, CancellationToken ct)
    {
        if (run.Seams is { } seams)
            File.WriteAllText(run.Files.SeamConstraintsJson, seams.ToJson());
        var command = PanoPreviewCommand.Build(
            inputs, run.Files, run.AlignmentIn, run.Options, host.Engine, host.ModelsDir, host.OrtDylibPath,
            constrained: run.Seams is not null);
        var exit = await PanoCliProcess.RunAsync(
            StartInfo(host.CliPath, command.Arguments, command.Environment), progress, ct);
        return PreviewOutcome(exit, run);
    }

    public static PanoPreviewOutcome PreviewOutcome(PanoCliExit exit, PanoPreviewRun run)
    {
        if (exit.Cancelled)
            return new PanoPreviewOutcome(false, true, null);
        if (exit.ExitCode != 0)
            return new PanoPreviewOutcome(false, false, PanoCliReport.Failure(exit, run.Files.ReportJson));
        if (!File.Exists(run.Files.PreviewPng) || !File.Exists(run.Files.AlignmentJson))
            return new PanoPreviewOutcome(false, false,
                "preview reported success but did not write the image and alignment");
        if ((PanoCliReport.Read(run.Files.ReportJson) is { } json ? PanoCliReport.Preview(json) : null)
            is not { } report)
            return new PanoPreviewOutcome(false, false,
                "preview reported success but did not write a readable report");
        if (run.Seams is { } seams && !seams.Matches(report.SeamConstraints))
            return new PanoPreviewOutcome(false, false, UnconfirmedSeams);
        return new PanoPreviewOutcome(true, false, null, report);
    }

    public static async Task<PanoStitchOutcome> StitchAsync(
        PanoCliHost host, PanoStitchRun run, Action<string> progress, CancellationToken ct)
    {
        if (run.Seams is { } seams)
            File.WriteAllText(seams.ConstraintsJson, seams.Request.ToJson());
        var command = PanoStitchCommand.Build(
            run.Inputs, run.OutPath, run.DisplayPath, run.Retention, run.LocalAlign, run.Strategy,
            run.AlignmentIn, host.Engine, host.ModelsDir, host.OrtDylibPath, run.Seams);
        var exit = await PanoCliProcess.RunAsync(
            StartInfo(host.CliPath, command.Arguments, command.Environment), progress, ct);
        return StitchOutcome(exit, run);
    }

    public static PanoStitchOutcome StitchOutcome(PanoCliExit exit, PanoStitchRun run)
    {
        if (exit.Cancelled)
            return new PanoStitchOutcome(false, true, "cancelled");
        if (exit.ExitCode != 0)
            return new PanoStitchOutcome(false, false, PanoCliReport.Failure(exit, run.Seams?.ReportJson));
        if (!File.Exists(run.OutPath) || !File.Exists(run.DisplayPath))
            return new PanoStitchOutcome(false, false,
                "stitch reported success but did not write both outputs "
                + $"(master: {File.Exists(run.OutPath)}, display: {File.Exists(run.DisplayPath)})");
        return run.Seams is { } seams ? ConstrainedOutcome(seams) : new PanoStitchOutcome(true, false, null);
    }

    // Regions drawn on one geometry are only honoured by a stitch that
    // reused that alignment, or solved it with no alignment offered. Any
    // other verdict, including a missing one, is treated as stale.
    private static PanoStitchOutcome ConstrainedOutcome(PanoSeamStitch seams)
    {
        var json = PanoCliReport.Read(seams.ReportJson);
        if (!seams.Request.Matches(json is null ? null : PanoCliReport.SeamEcho(json)))
            return new PanoStitchOutcome(false, false, UnconfirmedSeams);
        var status = PanoCliReport.AlignmentStatus(json!);
        return status is "solved" or "reused"
            ? new PanoStitchOutcome(true, false, null, status)
            : new PanoStitchOutcome(false, false, PanoSeamAuthoring.StaleGeometry, status);
    }

    private static ProcessStartInfo StartInfo(
        string cli, IReadOnlyList<string> arguments, IReadOnlyDictionary<string, string> environment)
    {
        var psi = new ProcessStartInfo { FileName = cli };
        foreach (var argument in arguments)
            psi.ArgumentList.Add(argument);
        foreach (var (name, value) in environment)
            psi.Environment[name] = value;
        return psi;
    }
}
