using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Maple.WinUI.Native;

namespace Maple.WinUI
{
    public partial class App : Application
    {
        private Window? _window;

        /// <summary>UI-thread dispatcher, captured at launch so background
        /// render/decode threads can marshal results back.</summary>
        public static DispatcherQueue? MainDispatcherQueue { get; private set; }

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
            Maple.WinUI.Services.DiagLog.Write("[boot] OnLaunched");
            RawFfi.VerifyAbi();
            MainDispatcherQueue = DispatcherQueue.GetForCurrentThread();
            _window = new MainWindow();
            Maple.WinUI.Services.DiagLog.Write("[boot] MainWindow constructed");
            _window.Activate();
            Maple.WinUI.Services.DiagLog.Write("[boot] activated");
        }
    }
}
