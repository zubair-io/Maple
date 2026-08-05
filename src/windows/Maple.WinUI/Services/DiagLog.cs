using System;
using System.IO;

namespace Maple.WinUI.Services
{
    /// <summary>Append-only diagnostics log at %LOCALAPPDATA%\Maple\maple.log —
    /// the unpackaged-app stand-in for a real trace session, used by the render
    /// paths to record GPU fallback reasons visible outside a debugger.</summary>
    public static class DiagLog
    {
        private static readonly object Gate = new();
        private static readonly string LogPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Maple", "maple.log");

        public static void Write(string message)
        {
            try
            {
                lock (Gate)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
                    File.AppendAllText(LogPath, $"{DateTime.Now:HH:mm:ss.fff} {message}{Environment.NewLine}");
                }
            }
            catch (IOException)
            {
            }
        }
    }
}
