using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Maple.WinUI.Native;

namespace Maple.WinUI
{
    public partial class App : Application
    {
        private static Window? _window;

        /// <summary>UI-thread dispatcher, captured at launch so background
        /// render/decode threads can marshal results back.</summary>
        public static DispatcherQueue? MainDispatcherQueue { get; private set; }

        /// <summary>File activation that arrived before OnLaunched created the
        /// window (Explorer double-click cold start: Program routes the launch
        /// activation through OnRedirectedActivation before the XAML framework
        /// raises OnLaunched). Consumed exactly once at the end of OnLaunched.</summary>
        private static IReadOnlyList<string>? _pendingFileActivation;

        /// <summary>Activation entry: invoked by Program for both the
        /// cold-start activation and redirected activations from second
        /// instances. Routes maple-app:// sign-in callbacks and Explorer
        /// file activations (#2797) to the main window on the UI thread.</summary>
        public static void OnRedirectedActivation(Microsoft.Windows.AppLifecycle.AppActivationArguments args)
        {
            // File activation (#2797): Explorer "Open with" / double-click on
            // a registered image type. The SDK registration delivers a real
            // File activation with IStorageItems; the registry-fallback
            // registration delivers the path as a plain Launch argument
            // instead — the Launch branch below accepts that form.
            if (args.Kind == Microsoft.Windows.AppLifecycle.ExtendedActivationKind.File
                && args.Data is Windows.ApplicationModel.Activation.IFileActivatedEventArgs fileArgs)
            {
                DeliverFileActivation(fileArgs.Files
                    .Select(f => f.Path)
                    .Where(p => !string.IsNullOrEmpty(p))
                    .ToList());
                return;
            }

            // Registered protocol activations arrive as Protocol; a raw
            // registry registration (or some shells) delivers the URI as a
            // plain Launch argument instead — accept both.
            Uri? uri = null;
            if (args.Kind == Microsoft.Windows.AppLifecycle.ExtendedActivationKind.Protocol
                && args.Data is Windows.ApplicationModel.Activation.IProtocolActivatedEventArgs protocol)
            {
                uri = protocol.Uri;
            }
            else if (args.Kind == Microsoft.Windows.AppLifecycle.ExtendedActivationKind.Launch
                && args.Data is Windows.ApplicationModel.Activation.ILaunchActivatedEventArgs launch)
            {
                var arg = launch.Arguments?.Trim().Trim('"');
                if (arg != null && arg.StartsWith("maple-app://", StringComparison.OrdinalIgnoreCase)
                    && Uri.TryCreate(arg, UriKind.Absolute, out var parsed))
                {
                    uri = parsed;
                }
                else if (arg != null && System.IO.File.Exists(arg))
                {
                    // Registry-fallback file activation: `"exe" "%1"`.
                    DeliverFileActivation(new[] { arg });
                    return;
                }
            }
            if (uri == null)
                return;
            Maple.WinUI.Services.DiagLog.Write($"[auth] callback activation: {uri.Scheme}://{uri.Host}");
            var captured = uri;
            MainDispatcherQueue?.TryEnqueue(() =>
                (_window as MainWindow)?.HandleAuthCallback(captured));
        }

        private static void DeliverFileActivation(IReadOnlyList<string> paths)
        {
            if (paths.Count == 0)
                return;
            Maple.WinUI.Services.DiagLog.Write($"[file-open] activation with {paths.Count} path(s)");
            if (MainDispatcherQueue == null || _window == null)
            {
                // Cold start — the window doesn't exist yet. Latch; OnLaunched
                // consumes after Activate(). A second cold-start activation
                // before the window exists supersedes the first, same as a
                // newer Finder open superseding on the Apple side.
                _pendingFileActivation = paths;
                return;
            }
            MainDispatcherQueue.TryEnqueue(() =>
                (_window as MainWindow)?.HandleFileActivation(paths));
        }

        public App()
        {
            this.InitializeComponent();
            this.UnhandledException += (_, e) =>
            {
                Maple.WinUI.Services.DiagLog.Write($"[crash] {e.Exception}");
                e.Handled = false;
            };
            AppDomain.CurrentDomain.UnhandledException += (_, e) =>
                Maple.WinUI.Services.DiagLog.Write($"[crash-domain] {e.ExceptionObject}");
        }

        protected override void OnLaunched(LaunchActivatedEventArgs args)
        {
            RawFfi.VerifyAbi();
            Controls.ToneCurveMath.VerifyParity();
            Maple.WinUI.Services.ProtocolRegistrar.EnsureRegistered();
            Maple.WinUI.Services.FileTypeRegistrar.EnsureRegistered();
            MainDispatcherQueue = DispatcherQueue.GetForCurrentThread();
            _window = new MainWindow();
            _window.Activate();
            // Cold-start file activation latched by DeliverFileActivation
            // before the window existed (#2797).
            if (_pendingFileActivation is { } pending)
            {
                _pendingFileActivation = null;
                (_window as MainWindow)?.HandleFileActivation(pending);
            }
        }
    }
}
