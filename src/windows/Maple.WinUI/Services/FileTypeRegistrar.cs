using System;
using System.Diagnostics;
using System.Linq;
using Microsoft.Win32;
using Maple.WinUI.Services.FileOperations;

namespace Maple.WinUI.Services
{
    /// <summary>
    /// Per-user registration of the image types Maple can open (HKCU\
    /// Software\Classes — no elevation, current user only), so Explorer
    /// lists Maple under "Open with" for RAWs and standard stills (#2797).
    /// Windows counterpart of the Apple CFBundleDocumentTypes claims
    /// (#2796), with the same "Alternate" semantics: the registration is
    /// additive (an OpenWithProgids entry, never the extension's default
    /// handler), so double-click stays with Photos or whatever the user
    /// chose until they pick Maple themselves. Self-registers at launch
    /// like ProtocolRegistrar — re-registering keeps the exe path fresh
    /// across rebuilds/moves. The extension list is
    /// DropMountLogic.SupportedExtensions verbatim: registering exactly
    /// what the open pipeline accepts means an activation can never land
    /// in the Unsupported arm of its own registration.
    /// </summary>
    public static class FileTypeRegistrar
    {
        private const string ProgId = "Maple.Exposure.Image";

        public static void EnsureRegistered()
        {
            var exePath = Process.GetCurrentProcess().MainModule?.FileName;
            if (string.IsNullOrEmpty(exePath))
                return;
            try
            {
                // The Windows App SDK registration makes reactivations arrive
                // as real File activations (kind + IStorageItem list), and
                // writes the additive OpenWithProgids wiring itself.
                Microsoft.Windows.AppLifecycle.ActivationRegistrationManager
                    .RegisterForFileTypeActivation(
                        DropMountLogic.SupportedExtensions.ToArray(),
                        System.IO.Path.Combine(AppContext.BaseDirectory, "Assets", "maple.ico"),
                        "Maple",
                        new[] { "open" },
                        exePath);
            }
            catch (Exception ex)
            {
                DiagLog.Write($"[file-types] SDK registration failed, falling back to registry: {ex.Message}");
                try
                {
                    RegisterViaRegistry(exePath);
                }
                catch (Exception inner)
                {
                    DiagLog.Write($"[file-types] registry registration failed: {inner.Message}");
                }
            }
        }

        /// <summary>Raw HKCU fallback, mirroring ProtocolRegistrar's: one
        /// ProgID with an open command, then an OpenWithProgids entry per
        /// extension. With this path activations arrive as plain Launch
        /// arguments ("%1"), which App.OnRedirectedActivation also accepts.</summary>
        private static void RegisterViaRegistry(string exePath)
        {
            using (var progIdKey = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{ProgId}"))
            {
                progIdKey.SetValue(null, "Maple Image");
                using (var iconKey = progIdKey.CreateSubKey("DefaultIcon"))
                    iconKey.SetValue(null, $"\"{exePath}\",0");
                using var commandKey = progIdKey.CreateSubKey(@"shell\open\command");
                var command = $"\"{exePath}\" \"%1\"";
                if (commandKey.GetValue(null) as string != command)
                    commandKey.SetValue(null, command);
            }
            foreach (var ext in DropMountLogic.SupportedExtensions)
            {
                using var openWith = Registry.CurrentUser
                    .CreateSubKey($@"Software\Classes\{ext}\OpenWithProgids");
                if (openWith.GetValue(ProgId) == null)
                    openWith.SetValue(ProgId, Array.Empty<byte>(), RegistryValueKind.None);
            }
        }
    }
}
