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
    ///
    /// INVARIANT (#2948): every partial write — toggling one UI flag, adding
    /// one library folder, protecting a new refresh token, … — MUST go
    /// through <see cref="Update"/>, never through
    /// `someCachedInstance.Save()` on an <see cref="AppSettings"/> that was
    /// loaded once and held onto (a UI-thread field captured at
    /// construction, say). A long-lived cached instance goes stale the
    /// moment ANY other code path writes a fresh file — including
    /// LibraryFolders edits made mid-session — and `Save()`ing it directly
    /// serializes that stale snapshot over the real file, silently
    /// reverting every field it didn't itself touch. That's exactly the bug
    /// #2948 fixed: MainWindow's sidebar toggle called
    /// `_settings.LeftPanelHidden = …; _settings.Save();` on a `_settings`
    /// field loaded once at construction, discarding any library folder
    /// added or renamed since. <see cref="Update"/> always re-loads
    /// immediately before applying the change, so it can never do this —
    /// use it (or, if truly outside the case Update covers, replicate its
    /// exact reload-then-write shape) for any NEW settings writer.
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
        // Pano provisioning overrides (#2583) — null = the PanoProvisioner
        // defaults under %LOCALAPPDATA%\Maple (pano-models\, ort\, and the
        // maple-cli.exe shipped beside the app).
        public string? PanoCliPath { get; set; }
        public string? PanoModelsDir { get; set; }
        public string? PanoOrtDylibPath { get; set; }

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

        /// <summary>The sanctioned way to persist a partial settings change
        /// — see this type's class-level INVARIANT comment. Always
        /// re-loads the current file from disk immediately before applying
        /// <paramref name="apply"/> and saving, so a change made by some
        /// OTHER code path since the last load (a library folder added or
        /// renamed elsewhere this session, a token protected by the sign-in
        /// flow, …) is never clobbered. <paramref name="apply"/> should
        /// mutate ONLY the field(s) this call site owns — it isn't a full
        /// replacement, it's a read-modify-write on top of whatever the
        /// file currently holds. Returns the loaded-and-updated instance in
        /// case a caller wants it (most don't).</summary>
        public static AppSettings Update(Action<AppSettings> apply)
        {
            var settings = Load();
            apply(settings);
            settings.Save();
            return settings;
        }
    }
}
