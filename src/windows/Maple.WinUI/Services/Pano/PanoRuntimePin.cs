using System;
using System.Runtime.InteropServices;

namespace Maple.WinUI.Services.Pano;

internal sealed record PanoRuntimePin(string Arch, string Sha256)
{
    public string Url => $"https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/onnxruntime-win-{Arch}-1.23.2.zip";
    public string DllEntry => $"onnxruntime-win-{Arch}-1.23.2/lib/onnxruntime.dll";

    public static PanoRuntimePin ForArchitecture(Architecture architecture) => architecture switch
    {
        Architecture.X64 => new("x64", "dec964ab1ee36cc9b0ae247d13b376627992fc57dec0454354017ab8fd84f1ea"),
        Architecture.Arm64 => new("arm64", "99a11bb077f723a81d100fd98099f332e4178bbb7025ac10fd40699a0b82c2f0"),
        _ => throw new PlatformNotSupportedException($"Panorama runtime is unavailable for {architecture}."),
    };
}
