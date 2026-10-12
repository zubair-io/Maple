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
}
