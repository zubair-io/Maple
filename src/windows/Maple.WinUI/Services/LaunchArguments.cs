using System;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;

namespace Maple.WinUI.Services;

internal static class LaunchArguments
{
    // Unpackaged redirected activations may include argv[0]; registered
    // Launch activations may contain only arguments. Preserve Windows quoting
    // rules in both cases (#3889), without probing paths on the UI thread.
    internal static string[] Parse(string? commandLine)
    {
        if (string.IsNullOrWhiteSpace(commandLine)) return Array.Empty<string>();
        // A dummy argv[0] gives every actual token normal argument semantics.
        var pointer = CommandLineToArgvW("maple " + commandLine, out var count);
        if (pointer == IntPtr.Zero) throw new Win32Exception();
        try
        {
            var arguments = Enumerable.Range(1, count - 1)
                .Select(i => Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i * IntPtr.Size))!)
                .ToArray();
            return arguments.Length > 0 &&
                Path.GetExtension(arguments[0]).Equals(".exe", StringComparison.OrdinalIgnoreCase)
                ? arguments.Skip(1).ToArray() : arguments;
        }
        finally { LocalFree(pointer); }
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
}
