using System;
using System.Runtime.InteropServices;
using Maple.WinUI.Services.Pano;
using Xunit;

namespace Maple.WinUI.Tests;

public class PanoRuntimePinTests
{
    [Theory]
    [InlineData(Architecture.X64, "x64")]
    [InlineData(Architecture.Arm64, "arm64")]
    public void RuntimeMatchesProcessArchitecture(Architecture architecture, string arch)
    {
        var pin = PanoRuntimePin.ForArchitecture(architecture);
        Assert.Equal(arch, pin.Arch);
        Assert.EndsWith($"/onnxruntime-win-{arch}-1.23.2.zip", pin.Url);
        Assert.Equal($"onnxruntime-win-{arch}-1.23.2/lib/onnxruntime.dll", pin.DllEntry);
        Assert.Matches("^[0-9a-f]{64}$", pin.Sha256);
        Assert.NotEqual(PanoRuntimePin.ForArchitecture(Architecture.X64).Sha256,
            PanoRuntimePin.ForArchitecture(Architecture.Arm64).Sha256);
    }

    [Fact]
    public void UnsupportedArchitectureFailsBeforeDownload() =>
        Assert.Throws<PlatformNotSupportedException>(() => PanoRuntimePin.ForArchitecture(Architecture.X86));
}
