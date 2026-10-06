using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private void VerifyEditorKeyboardFocus()
    {
        var previous = FocusManager.GetFocusedElement(Content.XamlRoot) as Control;
        try
        {
            foreach (var button in HeaderActionButtons(EditTopBar).Where(button => button.IsEnabled))
            {
                var name = AutomationProperties.GetName(button);
                if (!button.Focus(FocusState.Keyboard) ||
                    !ReferenceEquals(FocusManager.GetFocusedElement(Content.XamlRoot), button))
                    throw new InvalidOperationException($"Editor action cannot receive XAML keyboard focus: {name}");
                var peer = FrameworkElementAutomationPeer.CreatePeerForElement(button);
                if (peer == null || !peer.IsKeyboardFocusable() || !peer.HasKeyboardFocus() || peer.GetName() != name)
                    throw new InvalidOperationException($"Editor action automation peer does not report its keyboard focus/name: {name}");
            }
        }
        finally
        {
            previous?.Focus(FocusState.Programmatic);
        }
    }

    private void VerifyEditorHeaderBounds()
    {
        var header = EditTopBar.TransformToVisual(CanvasHost).TransformBounds(
            new Rect(0, 0, EditTopBar.ActualWidth, EditTopBar.ActualHeight));
        if (Math.Abs(header.Left + header.Width / 2 - CanvasHost.ActualWidth / 2) > 1 ||
            header.Left < 15 || header.Right > CanvasHost.ActualWidth - 15 || header.Width > 721)
            throw new InvalidOperationException("Editor header is not centered and bounded with outer margins");

        var buttons = HeaderActionButtons(EditTopBar).ToArray();
        var names = buttons.Select(AutomationProperties.GetName).ToArray();
        var comparisonName = _compare.ShowingBefore ? "Showing before; show edited photo" : "Compare before and after";
        foreach (var name in new[] { "Back to preview", "Undo adjustment", comparisonName,
            "More editing actions", "Export photo", "Shadow clipping indicator", "Highlight clipping indicator" })
            if (names.Count(candidate => candidate == name) != 1)
                throw new InvalidOperationException($"Missing or duplicated editor header action: {name}");
        foreach (var button in buttons)
        {
            var bounds = button.TransformToVisual(EditTopBar).TransformBounds(
                new Rect(0, 0, button.ActualWidth, button.ActualHeight));
            if (button.Visibility != Visibility.Visible || !button.IsTabStop ||
                bounds.Width < 44 || bounds.Height < 44 || bounds.Left < -.5 || bounds.Top < -.5 ||
                bounds.Right > EditTopBar.ActualWidth + .5 || bounds.Bottom > EditTopBar.ActualHeight + .5)
                throw new InvalidOperationException($"Editor header action clipped or unreachable: {AutomationProperties.GetName(button)} ({bounds})");
        }
    }

    private static IEnumerable<Button> HeaderActionButtons(DependencyObject parent)
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            if (child is Button button) yield return button;
            else foreach (var nested in HeaderActionButtons(child)) yield return nested;
        }
    }
}
