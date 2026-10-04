using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using Maple.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Automation.Provider;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private static async Task VerifyListRowAutomationAsync(string output)
    {
        var actionCount = 0;
        var toggle = new ToggleSwitch { Header = "Trailing option" };
        var row = new MuiListRow { Label = "Navigation", TrailingContent = toggle };
        row.Pressed += (_, _) => actionCount++;
        AutomationProperties.SetName(row, "Consumer navigation");
        var passive = new MuiListRow { Label = "Metadata" };
        var host = new StackPanel { Padding = new Thickness(24), Spacing = 16 };
        host.Children.Add(row);
        host.Children.Add(passive);
        var window = new Window { Title = "Maple list-row qualification", Content = host };
        window.AppWindow.Resize(new Windows.Graphics.SizeInt32(720, 480));
        window.Activate();
        try
        {
            var deadline = Environment.TickCount64 + 5000;
            while (host.XamlRoot == null && Environment.TickCount64 < deadline)
                await Task.Delay(50);
            Check("attached-window", host.XamlRoot != null && WinRT.Interop.WindowNative.GetWindowHandle(window) != IntPtr.Zero);
            host.UpdateLayout();
            var peer = FrameworkElementAutomationPeer.CreatePeerForElement(row);
            Check("action-role", peer?.GetAutomationControlType() == AutomationControlType.Button);
            Check("consumer-name", peer!.GetName() == "Consumer navigation");
            Check("row-target", row.ActualHeight >= 44);
            Check("keyboard-focus", row.Focus(FocusState.Keyboard) && peer.IsKeyboardFocusable()
                && peer.HasKeyboardFocus() && ReferenceEquals(FocusManager.GetFocusedElement(host.XamlRoot), row));
            var invoke = peer.GetPattern(PatternInterface.Invoke) as IInvokeProvider;
            Check("invoke-provider", invoke != null);
            invoke!.Invoke();
            Check("invoke-action", actionCount == 1 && !row.Active);
            row.Active = true;
            Check("current-status", peer.GetItemStatus() == "Current" && peer.GetName() == "Consumer navigation, current");
            row.Label = "Renamed label";
            row.Active = false;
            Check("name-and-status-reset", peer.GetName() == "Consumer navigation" && peer.GetItemStatus() == string.Empty);
            row.IsEnabled = false;
            var disabledRejected = false;
            try { invoke.Invoke(); }
            catch (ElementNotEnabledException) { disabledRejected = true; }
            Check("disabled-invoke", disabledRejected && actionCount == 1 && !peer.IsKeyboardFocusable());
            row.IsEnabled = true;
            var togglePeer = FrameworkElementAutomationPeer.CreatePeerForElement(toggle);
            Check("trailing-focus", toggle.Focus(FocusState.Keyboard) && togglePeer!.HasKeyboardFocus()
                && !peer.HasKeyboardFocus());
            var toggleProvider = togglePeer!.GetPattern(PatternInterface.Toggle) as IToggleProvider;
            Check("trailing-provider", toggleProvider != null);
            toggleProvider!.Toggle();
            Check("independent-trailing-action", toggle.IsOn && actionCount == 1);
            var passivePeer = FrameworkElementAutomationPeer.CreatePeerForElement(passive);
            Check("passive-row", passivePeer!.GetAutomationControlType() == AutomationControlType.Group
                && passivePeer.GetPattern(PatternInterface.Invoke) == null);
        }
        finally { window.Close(); }

        void Check(string name, bool passed)
        {
            if (!passed) throw new InvalidOperationException($"List-row provider regression: {name}");
            File.AppendAllText(Path.Combine(output, "list-row-provider.jsonl"),
                JsonSerializer.Serialize(new { name, passed, scope = "native-provider-not-OS-input" }) + Environment.NewLine);
        }
    }
}
