using System;
using System.Collections.Generic;
using System.Linq;
using Maple.UI.Atoms;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private void VerifyEditorHeaderBounds()
    {
        var header = EditTopBar.TransformToVisual(CanvasHost).TransformBounds(
            new Rect(0, 0, EditTopBar.ActualWidth, EditTopBar.ActualHeight));
        if (Math.Abs(header.Left + header.Width / 2 - CanvasHost.ActualWidth / 2) > 1 ||
            header.Left < 15 || header.Right > CanvasHost.ActualWidth - 15 || header.Width > 721)
            throw new InvalidOperationException("Editor header is not centered and bounded with outer margins");

        var buttons = HeaderActionButtons(EditTopBar).ToArray();
        var names = buttons.Select(AutomationProperties.GetName).ToArray();
        foreach (var name in new[] { "Back to preview", "Undo adjustment", "Compare before and after",
            "More editing actions", "Export photo" })
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

    private static IEnumerable<MuiButton> HeaderActionButtons(DependencyObject parent)
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            if (child is MuiButton button) yield return button;
            else foreach (var nested in HeaderActionButtons(child)) yield return nested;
        }
    }
}
