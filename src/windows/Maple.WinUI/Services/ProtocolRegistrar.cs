using System;
using System.Diagnostics;
using Microsoft.Win32;

namespace Maple.WinUI.Services
{
    /// <summary>
    /// Per-user registration of the maple-app:// URI scheme (HKCU\Software\
    /// Classes — no elevation, current user only). The web app's sign-in
    /// ceremony hands the one-time auth code back exclusively through this
    /// scheme, so the app self-registers at launch, pointing at the current
    /// exe (re-registering keeps the path fresh across rebuilds/moves).
    /// </summary>
    public static class ProtocolRegistrar
    {
        public const string Scheme = "maple-app";

        public static void EnsureRegistered()
        {
            var exePath = Process.GetCurrentProcess().MainModule?.FileName;
            if (string.IsNullOrEmpty(exePath))
                return;
            try
            {
                // The Windows App SDK registration makes reactivations arrive
                // as real Protocol activations (kind + parsed Uri).
                Microsoft.Windows.AppLifecycle.ActivationRegistrationManager
                    .RegisterForProtocolActivation(Scheme, string.Empty, "Maple App", exePath);
            }
            catch (Exception ex)
            {
                DiagLog.Write($"[protocol] SDK registration failed, falling back to registry: {ex.Message}");
                try
                {
                    var command = $"\"{exePath}\" \"%1\"";
                    using var root = Registry.CurrentUser.CreateSubKey($@"Software\Classes\{Scheme}");
                    root.SetValue(null, "URL:Maple App Protocol");
                    root.SetValue("URL Protocol", string.Empty);
                    using var commandKey = root.CreateSubKey(@"shell\open\command");
                    if (commandKey.GetValue(null) as string != command)
                        commandKey.SetValue(null, command);
                }
                catch (Exception inner)
                {
                    DiagLog.Write($"[protocol] registry registration failed: {inner.Message}");
                }
            }
        }
    }
}
