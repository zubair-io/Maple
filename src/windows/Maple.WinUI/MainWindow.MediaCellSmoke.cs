using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Maple.UI;
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
    private static async Task VerifyMediaCellAutomationAsync(string output, bool nativeInput)
    {
        var ledger = Path.Combine(output, "media-cell-provider.jsonl");
        if (File.Exists(ledger)) throw new InvalidOperationException("Media-cell qualification needs a fresh output directory.");
        var items = Enumerable.Range(0, 64).Select(i => new MuiFilmstripItem($"photo-{i}", null, $"Photo {i}")).ToArray();
        var rail = new MuiFilmstripRail { Items = items, ActiveId = "photo-0", PreviewNavigation = true, IsCollapsed = true, Height = 360 };
        var actions = 0;
        rail.Activated += (_, _) => actions++;
        var passive = new MuiMediaCell { Alt = "Passive image", ShowMetadata = false };
        var host = new StackPanel { Padding = new Thickness(24), Spacing = 16 };
        host.Children.Add(rail);
        host.Children.Add(passive);
        var window = new Window { Title = "Maple media-cell qualification", Content = host };
        window.AppWindow.Resize(new Windows.Graphics.SizeInt32(720, 720));
        window.Activate();
        try
        {
            var deadline = Environment.TickCount64 + 5000;
            while (host.XamlRoot == null && Environment.TickCount64 < deadline) await Task.Delay(50);
            Check("attached-window", host.XamlRoot != null && WinRT.Interop.WindowNative.GetWindowHandle(window) != IntPtr.Zero);
            host.UpdateLayout();
            var cells = FilmstripCells(rail).ToArray();
            Check("production-rail-cells", cells.Length == 64);
            var first = cells[0];
            var second = cells[1];
            var peer = FrameworkElementAutomationPeer.CreatePeerForElement(first)!;
            var secondPeer = FrameworkElementAutomationPeer.CreatePeerForElement(second)!;
            Check("action-role", peer.GetAutomationControlType() == AutomationControlType.Button);
            Check("name", peer.GetName() == "Photo 0");
            Check("selected-status", peer.GetItemStatus() == "Selected" && secondPeer.GetItemStatus() == string.Empty);
            Check("no-fabricated-selection", peer.GetPattern(PatternInterface.SelectionItem) == null);
            Check("native-focus", first.Focus(FocusState.Keyboard) && peer.IsKeyboardFocusable() && peer.HasKeyboardFocus());
            var invoke = secondPeer.GetPattern(PatternInterface.Invoke) as IInvokeProvider;
            Check("invoke-provider", invoke != null);
            invoke!.Invoke();
            Check("invoke-production-selection", actions == 1 && rail.ActiveId == "photo-1" && second.Selected && !first.Selected);
            Check("updated-selected-status", secondPeer.GetItemStatus() == "Selected" && peer.GetItemStatus() == string.Empty);
            second.IsEnabled = false;
            var rejected = false;
            try { invoke.Invoke(); } catch (ElementNotEnabledException) { rejected = true; }
            Check("disabled-invoke", rejected && actions == 1 && !secondPeer.IsKeyboardFocusable());
            second.IsEnabled = true;
            second.Focus(FocusState.Keyboard);
            var scroll = FindDescendant<ScrollViewer>(rail)!;
            Check("scrollable-library", scroll.ScrollableHeight > 0);
            var offset = scroll.VerticalOffset;
            rail.IsCollapsed = false;
            host.UpdateLayout();
            rail.IsCollapsed = true;
            host.UpdateLayout();
            Check("toggle-preserves-state", rail.ActiveId == "photo-1" && secondPeer.HasKeyboardFocus()
                && ReferenceEquals(FilmstripCells(rail).Skip(1).First(), second) && scroll.VerticalOffset == offset);
            items[1] = new MuiFilmstripItem("photo-1", null, "Renamed photo", Metadata: "DNG · 9 KB");
            rail.Items = items.ToArray();
            Check("metadata-refresh-preserves-cell", ReferenceEquals(FilmstripCells(rail).Skip(1).First(), second)
                && secondPeer.GetName() == "Renamed photo" && secondPeer.GetItemStatus() == "Selected"
                && secondPeer.HasKeyboardFocus());
            var passivePeer = FrameworkElementAutomationPeer.CreatePeerForElement(passive)!;
            Check("passive-provider", passivePeer.GetAutomationControlType() == AutomationControlType.Group
                && passivePeer.GetPattern(PatternInterface.Invoke) == null && !passive.IsTabStop && !passivePeer.IsKeyboardFocusable());
            var detached = 0;
            EventHandler handler = (_, _) => detached++;
            passive.Pressed += handler;
            Check("attach-action", passive.IsTabStop && passivePeer.GetPattern(PatternInterface.Invoke) is IInvokeProvider);
            passive.Pressed -= handler;
            Check("detach-action", !passive.IsTabStop && passivePeer.GetPattern(PatternInterface.Invoke) == null && detached == 0);
            if (nativeInput)
            {
                rail.ActiveId = "photo-0";
                rail.IsCollapsed = true;
                first.Focus(FocusState.Keyboard);
                actions = 0;
                var events = new List<string>();
                var outOfOrder = false;
                void Record(int phase, string name)
                {
                    if (phase != events.Count) outOfOrder = true;
                    events.Add(name);
                    File.AppendAllText(Path.Combine(output, "media-cell-input-events.jsonl"),
                        JsonSerializer.Serialize(new { phase, name, outOfOrder }) + Environment.NewLine);
                }
                first.AddHandler(UIElement.PointerPressedEvent, new PointerEventHandler((_, e) =>
                {
                    if (e.GetCurrentPoint(first).Properties.IsLeftButtonPressed) Record(0, "first-photo-pointer");
                }), true);
                first.AddHandler(UIElement.KeyDownEvent, new KeyEventHandler((_, e) =>
                {
                    if (!ReferenceEquals(FocusManager.GetFocusedElement(host.XamlRoot), first)) return;
                    if (e.Key == Windows.System.VirtualKey.Space) Record(1, "photo-space");
                    if (e.Key == Windows.System.VirtualKey.Enter) Record(2, "photo-enter");
                }), true);
                second.AddHandler(UIElement.PointerPressedEvent, new PointerEventHandler((_, e) =>
                {
                    if (e.GetCurrentPoint(second).Properties.IsLeftButtonPressed) Record(3, "second-photo-pointer");
                }), true);
                var toggle = FindDescendant<Button>(rail)!;
                toggle.AddHandler(UIElement.PointerPressedEvent, new PointerEventHandler((_, e) =>
                {
                    if (e.GetCurrentPoint(toggle).Properties.IsLeftButtonPressed) Record(4, "expand-pointer");
                }), true);
                var thirdRow = (Grid)VisualTreeHelper.GetParent(cells[2]);
                thirdRow.AddHandler(UIElement.PointerPressedEvent, new PointerEventHandler((_, e) =>
                {
                    if (!rail.IsCollapsed && ReferenceEquals(e.OriginalSource, thirdRow)
                        && e.GetCurrentPoint(thirdRow).Properties.IsLeftButtonPressed) Record(5, "expanded-metadata-pointer");
                }), true);
                await File.WriteAllTextAsync(Path.Combine(output, "media-cell-input.ready"),
                    JsonSerializer.Serialize(new { deadlineSeconds = 240, sequence = "Click first photo; Space; Enter; click second thumbnail; expand; click third metadata row" }));
                deadline = Environment.TickCount64 + 240000;
                while ((events.Count < 6 || actions < 5) && Environment.TickCount64 < deadline) await Task.Delay(100);
                await File.WriteAllTextAsync(Path.Combine(output, "media-cell-input.json"),
                    JsonSerializer.Serialize(new { events, outOfOrder, actions, active = rail.ActiveId, expanded = !rail.IsCollapsed }));
                Check("ordered-native-input", events.Count == 6 && !outOfOrder);
                Check("native-input-selection", actions == 5 && rail.ActiveId == "photo-2" && !rail.IsCollapsed
                    && cells[2].Selected && !first.Selected && !second.Selected);
            }
        }
        finally { window.Close(); }

        void Check(string name, bool passed)
        {
            File.AppendAllText(ledger, JsonSerializer.Serialize(new { name, passed, scope = "native-provider" }) + Environment.NewLine);
            if (!passed) throw new InvalidOperationException($"Media-cell qualification failed: {name}");
        }
    }

}
