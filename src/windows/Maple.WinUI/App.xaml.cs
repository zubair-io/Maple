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
        }

        protected override void OnLaunched(LaunchActivatedEventArgs args)
        {
            RawFfi.VerifyAbi();
            MainDispatcherQueue = DispatcherQueue.GetForCurrentThread();
            _window = new MainWindow();
            _window.Activate();
        }
    }
}
