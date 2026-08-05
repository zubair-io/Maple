using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;

namespace Maple.WinUI.Services
{
    /// <summary>
    /// Persisted app settings for the unpackaged desktop app (a JSON file under
    /// %LOCALAPPDATA%\Maple — ApplicationData is unavailable when
    /// WindowsPackageType=None). Mirrors the cm.* persistence namespace used by
    /// the other shells.
    /// </summary>
    public sealed class AppSettings
    {
        public List<string> LibraryFolders { get; set; } = new();
        public string? CloudServerUrl { get; set; }
        public string? CloudEmail { get; set; }
        public bool LeftPanelHidden { get; set; }
        public bool DetailPanelHidden { get; set; }
        public double LeftPanelWidth { get; set; } = 260;
        public double DetailPanelWidth { get; set; } = 320;

        private static string SettingsPath => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Maple", "settings.json");

        public static AppSettings Load()
        {
            try
            {
                if (!File.Exists(SettingsPath))
                    return new AppSettings();
                return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(SettingsPath))
                    ?? new AppSettings();
            }
            catch (Exception ex) when (ex is IOException or JsonException)
            {
                return new AppSettings();
            }
        }

        public void Save()
        {
            var dir = Path.GetDirectoryName(SettingsPath)!;
            Directory.CreateDirectory(dir);
            File.WriteAllText(SettingsPath,
                JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        }
    }
}
