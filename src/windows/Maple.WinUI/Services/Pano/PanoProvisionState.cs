namespace Maple.WinUI.Services.Pano;

/// <summary>What a stitch with <see cref="Engine"/> still lacks. Models and
/// ORT only gate the ML engine; classical needs nothing beyond maple-cli.</summary>
public sealed record PanoProvisionState(PanoFeatureEngine Engine, bool Cli, bool Models, bool Ort)
{
    public bool NeedsDownload => Engine == PanoFeatureEngine.Ml && !(Models && Ort);

    public bool IsReady => Cli && !NeedsDownload;

    public string Summary => Engine == PanoFeatureEngine.Ml
        ? $"maple-cli: {Ready(Cli)} · models: {Ready(Models)} · ONNX Runtime: {Ready(Ort)}"
        : $"maple-cli: {Ready(Cli)} · matcher: classical (built in, no download)";

    private static string Ready(bool present) => present ? "ready" : "missing";
}
