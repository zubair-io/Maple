namespace Maple.WinUI.Services.Pano;

/// <summary>The detector/matcher maple-cli runs (#4556): the classical
/// engine ships in the binary and needs no download; the ML engine
/// (ALIKED + LightGlue on ONNX Runtime) is opt-in and provisioned on demand.</summary>
public enum PanoFeatureEngine
{
    Classical,
    Ml,
}

public static class PanoFeatureEngines
{
    public static PanoFeatureEngine FromSetting(bool useMlMatcher) =>
        useMlMatcher ? PanoFeatureEngine.Ml : PanoFeatureEngine.Classical;

    public static string CliValue(this PanoFeatureEngine engine) =>
        engine == PanoFeatureEngine.Ml ? "ml" : "classical";

    /// <summary>`--features-engine`, plus `--models-dir` for the ML engine
    /// only, so a classical run never depends on anything provisioned.</summary>
    public static string[] CliArguments(this PanoFeatureEngine engine, string modelsDir) =>
        engine == PanoFeatureEngine.Ml
            ? new[] { "--features-engine", engine.CliValue(), "--models-dir", modelsDir }
            : new[] { "--features-engine", engine.CliValue() };

    /// <summary>The ONNX Runtime locations, set for the ML engine only.</summary>
    public static System.Collections.Generic.IReadOnlyDictionary<string, string> CliEnvironment(
        this PanoFeatureEngine engine, string modelsDir, string ortDylibPath) =>
        engine == PanoFeatureEngine.Ml
            ? new System.Collections.Generic.Dictionary<string, string>
            {
                ["MAPLE_PANO_MODELS"] = modelsDir,
                ["ORT_DYLIB_PATH"] = ortDylibPath,
            }
            : new System.Collections.Generic.Dictionary<string, string>();
}
