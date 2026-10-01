using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class WindowsArgumentsFactAttribute : FactAttribute
{
    public WindowsArgumentsFactAttribute()
    {
        if (!OperatingSystem.IsWindows()) Skip = "Exercises the Windows shell command-line parser.";
    }
}

public sealed class LaunchArgumentsTests
{
    [WindowsArgumentsFact]
    public void RedirectedExecutableIsNotPartOfPhotoPath()
    {
        Assert.Equal(new[] { @"C:\Photo Library\夏 holiday.jpg" },
            LaunchArguments.Parse("\"C:\\Program Files\\Maple\\Maple.exe\" \"C:\\Photo Library\\夏 holiday.jpg\""));
        Assert.Equal(new[] { @"C:\Photos\first.jpg", @"\\server\share\second photo.CR3" },
            LaunchArguments.Parse("C:\\Maple.exe C:\\Photos\\first.jpg \"\\\\server\\share\\second photo.CR3\""));
    }

    [WindowsArgumentsFact]
    public void ArgumentOnlyActivationAndProtocolRemainIntact()
    {
        Assert.Equal(new[] { @"C:\Photo Library\first.jpg" },
            LaunchArguments.Parse("\"C:\\Photo Library\\first.jpg\""));
        const string callback = "maple-app://callback?code=abc&state=def";
        Assert.Equal(new[] { callback }, LaunchArguments.Parse("\"C:\\Maple.exe\" \"" + callback + "\""));
        Assert.Equal(new[] { callback }, LaunchArguments.Parse(callback));
        Assert.Empty(LaunchArguments.Parse(null));
        Assert.Empty(LaunchArguments.Parse("  "));
        Assert.Empty(LaunchArguments.Parse("\"C:\\Maple.exe\""));
    }
}
