using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Maple.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Automation.Provider;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private static async Task VerifyListRowWrapperActionsAsync(string output)
    {
        var list = new MuiListView { Items = new[] { new MuiListViewItem("photo", "List photo") }, Height = 80 };
        var backlinks = new MuiBacklinksPanel { Backlinks = new[] { new MuiBacklink("ref", "Backlink", "info") } };
        var components = new MuiMaskComposition();
        components.Sync(new[] { new MuiMaskComponentRow("Component", "Add", false, false) }, 1, false);
        var masks = new MuiMaskPanel { Layers = new[] { new MuiMaskLayerRow("mask", "Layer", "", false, false) } };
        var host = new StackPanel();
        foreach (var control in new UIElement[] { list, backlinks, components, masks }) host.Children.Add(control);
        var window = new Window { Title = "Maple list-row wrapper qualification", Content = new ScrollViewer { Content = host } };
        window.Activate();
        try
        {
            var deadline = Environment.TickCount64 + 5000;
            while (host.XamlRoot == null && Environment.TickCount64 < deadline) await Task.Delay(50);
            host.UpdateLayout();
            var selected = Array.Empty<string>();
            var listCalls = 0;
            EventHandler<IReadOnlyList<string>> listAction = (_, ids) => { selected = ids.ToArray(); listCalls++; };
            Verify(list, "List photo", () => list.SelectionChanged += listAction,
                () => list.SelectionChanged -= listAction, () => selected.SequenceEqual(new[] { "photo" }),
                () => list.Items = new[] { new MuiListViewItem("photo", "List photo") }, () => listCalls);
            var backlinkId = string.Empty;
            var backlinkCalls = 0;
            EventHandler<string> backlinkAction = (_, id) => { backlinkId = id; backlinkCalls++; };
            Verify(backlinks, "Backlink", () => backlinks.BacklinkActivated += backlinkAction,
                () => backlinks.BacklinkActivated -= backlinkAction, () => backlinkId == "ref",
                () => backlinks.Backlinks = new[] { new MuiBacklink("ref", "Backlink", "info") }, () => backlinkCalls);
            var componentIndex = -1;
            var componentCalls = 0;
            EventHandler<int> componentAction = (_, index) => { componentIndex = index; componentCalls++; };
            Verify(components, "Component", () => components.Selected += componentAction,
                () => components.Selected -= componentAction, () => componentIndex == 0,
                () => components.Sync(new[] { new MuiMaskComponentRow("Component", "Subtract", false, false) }, 1, false), () => componentCalls);
            var layerIndex = -1;
            var layerCalls = 0;
            EventHandler<int> layerAction = (_, index) => { layerIndex = index; layerCalls++; };
            Verify(masks, "Layer", () => masks.LayerSelected += layerAction,
                () => masks.LayerSelected -= layerAction, () => layerIndex == 0,
                () => masks.Layers = new[] { new MuiMaskLayerRow("mask", "Layer", "", false, false) }, () => layerCalls);
        }
        finally { window.Close(); }

        void Verify(DependencyObject wrapper, string label, Action attach, Action detach, Func<bool> acted, Action rebuild, Func<int> calls)
        {
            var row = FindRow(wrapper, label) ?? throw new InvalidOperationException($"Missing wrapper row: {label}");
            var peer = FrameworkElementAutomationPeer.CreatePeerForElement(row)!;
            Check("passive", !row.IsTabStop && peer.GetAutomationControlType() == AutomationControlType.Group
                && peer.GetPattern(PatternInterface.Invoke) == null);
            attach();
            attach();
            Check("attached", row.IsTabStop && peer.GetAutomationControlType() == AutomationControlType.Button);
            ((IInvokeProvider)peer.GetPattern(PatternInterface.Invoke)).Invoke();
            Check("real-action", acted() && calls() == 2 && !row.Active);
            detach();
            Check("one-subscriber-remains", row.IsTabStop && peer.GetPattern(PatternInterface.Invoke) is IInvokeProvider);
            ((IInvokeProvider)peer.GetPattern(PatternInterface.Invoke)).Invoke();
            Check("one-forwarder-remains", calls() == 3);
            detach();
            Check("detached", !row.IsTabStop && peer.GetPattern(PatternInterface.Invoke) == null
                && ReferenceEquals(row, FindRow(wrapper, label)));
            attach();
            rebuild();
            host.UpdateLayout();
            row = FindRow(wrapper, label) ?? throw new InvalidOperationException($"Missing rebuilt wrapper row: {label}");
            peer = FrameworkElementAutomationPeer.CreatePeerForElement(row)!;
            Check("rebuilt-action", row.IsTabStop && peer.GetPattern(PatternInterface.Invoke) is IInvokeProvider);
            ((IInvokeProvider)peer.GetPattern(PatternInterface.Invoke)).Invoke();
            Check("rebuilt-real-action", calls() == 4);
            detach();
            Check("rebuilt-detached", !row.IsTabStop && peer.GetAutomationControlType() == AutomationControlType.Group
                && peer.GetPattern(PatternInterface.Invoke) == null);

            void Check(string name, bool passed)
            {
                File.AppendAllText(Path.Combine(output, "list-row-wrappers.jsonl"),
                    JsonSerializer.Serialize(new { wrapper = wrapper.GetType().Name, name, passed, scope = "native-provider" }) + Environment.NewLine);
                if (!passed) throw new InvalidOperationException($"List-row wrapper regression: {label}/{name}");
            }
        }

        static MuiListRow? FindRow(DependencyObject parent, string label)
        {
            if (parent is MuiListRow row && row.Label == label) return row;
            for (var i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
                if (FindRow(VisualTreeHelper.GetChild(parent, i), label) is { } found) return found;
            return null;
        }
    }
}
