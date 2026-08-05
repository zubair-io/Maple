using System;
using System.Threading;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;

namespace Maple.WinUI
{
    /// <summary>
    /// Custom entry point (DISABLE_XAML_GENERATED_MAIN): the maple-app://
    /// sign-in callback launches a second process, which must redirect its
    /// activation to the running instance instead of opening a second window.
    /// </summary>
    public static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            WinRT.ComWrappersSupport.InitializeComWrappers();

            var mainInstance = AppInstance.FindOrRegisterForKey("maple-main");
            var activation = AppInstance.GetCurrent().GetActivatedEventArgs();
            if (!mainInstance.IsCurrent)
            {
                mainInstance.RedirectActivationToAsync(activation).AsTask().GetAwaiter().GetResult();
                return;
            }

            Application.Start(_ =>
            {
                var context = new DispatcherQueueSynchronizationContext(
                    DispatcherQueue.GetForCurrentThread());
                SynchronizationContext.SetSynchronizationContext(context);
                var app = new App();
                mainInstance.Activated += (_, redirected) => App.OnRedirectedActivation(redirected);
                // The launching activation may itself be a protocol activation
                // (app cold-started by the browser redirect).
                App.OnRedirectedActivation(activation);
            });
        }
    }
}
