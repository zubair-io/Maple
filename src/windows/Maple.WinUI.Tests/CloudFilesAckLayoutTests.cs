using System.Runtime.InteropServices;
using Maple.WinUI.Services.CloudFiles;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class CloudFilesAckLayoutTests
{
    [Fact]
    public void AckOperationParametersMatchCfapiX64UnionLayout()
    {
        Assert.Equal(16, Marshal.SizeOf<CfApi.CF_OPERATION_PARAMETERS_ACK>());
        Assert.Equal(8, Marshal.OffsetOf<CfApi.CF_OPERATION_PARAMETERS_ACK>("Flags").ToInt32());
        Assert.Equal(12, Marshal.OffsetOf<CfApi.CF_OPERATION_PARAMETERS_ACK>("CompletionStatus").ToInt32());
    }

    [Fact]
    public void NotifyCallbackFlagsAndRenameTargetMatchCfapi64BitUnionOffsets()
    {
        Assert.Contains(RuntimeInformation.ProcessArchitecture, new[] { Architecture.X64, Architecture.Arm64 });
        Assert.Equal(8, IntPtr.Size);
        Assert.Equal(8, Marshal.OffsetOf<CfApi.CF_CALLBACK_PARAMETERS_NOTIFY>("Flags").ToInt32());
        Assert.Equal(16, Marshal.OffsetOf<CfApi.CF_CALLBACK_PARAMETERS_NOTIFY>("TargetPath").ToInt32());
        Assert.Equal(24, Marshal.SizeOf<CfApi.CF_CALLBACK_PARAMETERS_NOTIFY>());
    }
}
