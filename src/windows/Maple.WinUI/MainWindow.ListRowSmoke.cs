using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using Maple.UI;
using Maple.UI.Atoms;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Automation.Provider;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private static async Task VerifyListRowAutomationAsync(string output, bool nativeInput)
    {
        await VerifyListRowCallersAsync(output);
        var actionCount = 0;
        var toggle = new ToggleSwitch { Header = "Trailing option" };
        var row = new MuiListRow { Label = "Navigation", TrailingContent = toggle };
        EventHandler rowAction = (_, _) => actionCount++;
        row.Pressed += rowAction;
        AutomationProperties.SetName(row, "Consumer navigation");
        var passive = new MuiListRow { Label = "Metadata" };
        var decorativeActions = 0;
        var decorative = new MuiListRow
        {
            Label = "Decorative trailing",
            TrailingContent = new MuiIcon { IconName = "chevron-right" },
        };
        decorative.Pressed += (_, _) => decorativeActions++;
        var host = new StackPanel { Padding = new Thickness(24), Spacing = 16 };
        host.Children.Add(row);
        host.Children.Add(passive);
        host.Children.Add(decorative);
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
            Check("focused-peer", ReferenceEquals(peer.GetFocusedElement(), peer));
            toggle.Focus(FocusState.Keyboard);
            peer.SetFocus();
            Check("automation-set-focus", peer.HasKeyboardFocus()
                && ReferenceEquals(FocusManager.GetFocusedElement(host.XamlRoot), row));
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
                && passivePeer.GetPattern(PatternInterface.Invoke) == null && !passive.IsTabStop
                && !passivePeer.IsKeyboardFocusable());
            row.Pressed -= rowAction;
            Check("trailing-only-focus", !row.IsTabStop && toggle.IsTabStop
                && toggle.Focus(FocusState.Keyboard) && togglePeer.HasKeyboardFocus());
            Check("detached-action-provider", peer.GetAutomationControlType() == AutomationControlType.Group
                && peer.GetPattern(PatternInterface.Invoke) == null);
            row.Pressed += rowAction;
            Check("restored-action-provider", row.IsTabStop
                && peer.GetAutomationControlType() == AutomationControlType.Button
                && peer.GetPattern(PatternInterface.Invoke) is IInvokeProvider);
            if (nativeInput)
            {
                // Production passive rows skip Tab. Temporarily focus this row only
                // to exercise its routed-key guard with real OS input.
                passive.IsTabStop = true;
                var passiveEnter = false;
                var passiveSpace = false;
                var passiveHandled = false;
                var events = new List<string>();
                var outOfOrder = false;
                void Record(string name, int phase)
                {
                    outOfOrder |= events.Count != phase;
                    events.Add(name);
                }
                host.AddHandler(UIElement.KeyDownEvent, new KeyEventHandler((_, e) =>
                {
                    var focused = FocusManager.GetFocusedElement(host.XamlRoot);
                    if (ReferenceEquals(focused, row)
                        && e.Key is Windows.System.VirtualKey.Enter or Windows.System.VirtualKey.Space)
                        Record("row-keyboard", 0);
                    if (ReferenceEquals(focused, toggle) && e.Key == Windows.System.VirtualKey.Space)
                        Record("toggle-space", 1);
                    if (!ReferenceEquals(focused, passive)) return;
                    if (e.Key == Windows.System.VirtualKey.Enter) { passiveEnter = true; Record("passive-enter", 2); }
                    else if (e.Key == Windows.System.VirtualKey.Space) { passiveSpace = true; Record("passive-space", 3); }
                    else return;
                    passiveHandled |= e.Handled;
                }), true);
                host.AddHandler(UIElement.PointerPressedEvent, new PointerEventHandler((_, e) =>
                {
                    if (!e.GetCurrentPoint(decorative).Properties.IsLeftButtonPressed) return;
                    for (var source = e.OriginalSource as DependencyObject; source != null;
                        source = VisualTreeHelper.GetParent(source))
                    {
                        if (ReferenceEquals(source, decorative.TrailingContent)) { Record("decorative-pointer", 4); return; }
                        if (ReferenceEquals(source, decorative)) return;
                        if (ReferenceEquals(source, host)) return;
                    }
                }), true);
                actionCount = 0;
                toggle.IsOn = false;
                row.Focus(FocusState.Keyboard);
                await File.WriteAllTextAsync(Path.Combine(output, "input-ready.json"),
                    JsonSerializer.Serialize(new { title = window.Title, scope = "requires-actual-OS-input" }));
                // Screenshot-backed OS input can span several tool round trips.
                var inputDeadline = Environment.TickCount64 + 240000;
                while ((actionCount != 1 || decorativeActions != 1 || !toggle.IsOn
                    || !passiveEnter || !passiveSpace || events.Count < 5)
                    && Environment.TickCount64 < inputDeadline) await Task.Delay(50);
                await File.WriteAllTextAsync(Path.Combine(output, "native-input-result.json"),
                    JsonSerializer.Serialize(new { actionCount, decorativeActions, toggleOn = toggle.IsOn,
                        passiveEnter, passiveSpace, passiveHandled, events, outOfOrder,
                        passiveFocusOverride = true }));
                Check("native-keyboard-and-trailing-pointer", actionCount == 1 && decorativeActions == 1
                    && toggle.IsOn && events.Count == 5 && !outOfOrder,
                    "actual-keyboard-and-pointer");
                Check("passive-activation-keys-bubble", passiveEnter && passiveSpace && !passiveHandled,
                    "actual-keyboard-routed-through-passive-row");
            }
        }
        finally { window.Close(); }

        void Check(string name, bool passed, string scope = "native-provider-not-OS-input")
        {
            if (!passed) throw new InvalidOperationException($"List-row provider regression: {name}");
            File.AppendAllText(Path.Combine(output, "list-row-provider.jsonl"),
                JsonSerializer.Serialize(new { name, passed, scope }) + Environment.NewLine);
        }
    }
}
