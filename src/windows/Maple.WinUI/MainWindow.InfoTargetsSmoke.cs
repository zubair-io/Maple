using System;
using System.Linq;
using Maple.UI.Atoms;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Media;
using Windows.Foundation;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private void VerifyInspectorActionTargets()
    {
        var actions = Buttons(InfoPane).ToArray();
        if (actions.Length < 8) throw new InvalidOperationException("Inspector actions are missing.");
        foreach (var action in actions)
        {
            if (action.ActualWidth < 44 || action.ActualHeight < 44)
                throw new InvalidOperationException($"Inspector target below 44 DIP: {AutomationProperties.GetName(action)} "
                    + $"{action.ActualWidth}x{action.ActualHeight}");
        }
        var clear = actions.Single(action => AutomationProperties.GetName(action) == "Clear rating");
        var lastStar = _starButtons[4];
        var starBounds = lastStar.TransformToVisual(clear.Parent as UIElement).TransformBounds(
            new Rect(0, 0, lastStar.ActualWidth, lastStar.ActualHeight));
        var clearBounds = clear.TransformToVisual(clear.Parent as UIElement).TransformBounds(
            new Rect(0, 0, clear.ActualWidth, clear.ActualHeight));
        if (starBounds.Right > clearBounds.Left || clearBounds.Right > ((FrameworkElement)clear.Parent).ActualWidth)
            throw new InvalidOperationException("Rating stars overlap Clear or exceed the inspector row.");

        static System.Collections.Generic.IEnumerable<MuiButton> Buttons(DependencyObject parent)
        {
            for (var i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
            {
                var child = VisualTreeHelper.GetChild(parent, i);
                if (child is MuiButton button) yield return button;
                else foreach (var descendant in Buttons(child)) yield return descendant;
            }
        }
    }
}
