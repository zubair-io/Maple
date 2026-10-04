using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyHslAccessibilityAsync()
    {
        ToggleGroupPanel("Color");
        ShowColorTab("HSL");
        await Task.Delay(50);
        ((FrameworkElement)Content).UpdateLayout();
        var controls = HslDescendants(PanelHslBands).ToArray();
        var sliders = controls.OfType<Slider>().ToArray();
        var buttons = controls.OfType<Button>().ToArray();
        var expected = from band in new[] { "Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta" }
                       from channel in new[] { "hue", "saturation", "luminance" }
                       select $"{band} {channel}";
        if (sliders.Length != 24 || buttons.Length != 24)
            throw new InvalidOperationException("HSL did not realize all 24 slider and numeric-button pairs.");
        foreach (var name in expected)
            if (sliders.Count(c => AutomationProperties.GetName(c) == name && c.ActualHeight > 0) != 1
                || buttons.Count(c => AutomationProperties.GetName(c) == name && c.ActualHeight > 0) != 1)
                throw new InvalidOperationException($"HSL accessible pair is missing or ambiguous: {name}");
        ToggleGroupPanel("Light");
        await Task.Delay(50);
        ((FrameworkElement)Content).UpdateLayout();
        var ordinary = HslDescendants(PanelSliders).OfType<Slider>();
        if (!ordinary.Any(c => AutomationProperties.GetName(c) == "Exposure" && c.ActualHeight > 0))
            throw new InvalidOperationException("Ordinary Exposure accessibility name lost its label fallback.");
    }

    private static IEnumerable<DependencyObject> HslDescendants(DependencyObject parent)
    {
        for (var i = 0; i < VisualTreeHelper.GetChildrenCount(parent); i++)
        {
            var child = VisualTreeHelper.GetChild(parent, i);
            yield return child;
            foreach (var descendant in HslDescendants(child)) yield return descendant;
        }
    }
}
