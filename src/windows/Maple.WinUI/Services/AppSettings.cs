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
        /// <summary>DPAPI-protected (current user) device refresh token from the
        /// native-code sign-in — never stored in plain text.</summary>
        public string? CloudRefreshTokenProtected { get; set; }

        public void ProtectCloudRefreshToken(string refreshToken)
        {
            var blob = System.Security.Cryptography.ProtectedData.Protect(
                System.Text.Encoding.UTF8.GetBytes(refreshToken), null,
                System.Security.Cryptography.DataProtectionScope.CurrentUser);
            CloudRefreshTokenProtected = Convert.ToBase64String(blob);
        }

        public string? UnprotectCloudRefreshToken()
        {
            if (string.IsNullOrEmpty(CloudRefreshTokenProtected))
                return null;
            try
            {
                var raw = System.Security.Cryptography.ProtectedData.Unprotect(
                    Convert.FromBase64String(CloudRefreshTokenProtected),
                    null, System.Security.Cryptography.DataProtectionScope.CurrentUser);
                return System.Text.Encoding.UTF8.GetString(raw);
            }
            catch (System.Security.Cryptography.CryptographicException)
            {
                return null;
            }
        }
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
