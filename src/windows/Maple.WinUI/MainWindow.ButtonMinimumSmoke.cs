using System;
using System.Threading.Tasks;
using Maple.UI.Atoms;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Data;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyButtonMinimumHeightAsync()
    {
        var root = Content as Grid ?? throw new InvalidOperationException("Button qualification requires the root Grid.");
        var host = new StackPanel { HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top };
        var button = new MuiButton { Label = "Minimum height qualification", Width = 240, ButtonSize = MuiButtonSize.Sm };
        host.Children.Add(button);
        root.Children.Add(host);
        try
        {
            await CheckAsync(28);
            button.MinHeight = 64;
            button.Label = "Updated label";
            button.Variant = MuiButtonVariant.Ghost;
            button.ButtonSize = MuiButtonSize.Lg;
            button.IsLoading = true;
            button.IsLoading = false;
            await CheckAsync(64);
            button.ClearValue(FrameworkElement.MinHeightProperty);
            await CheckAsync(44);
            button.ButtonSize = MuiButtonSize.Sm;
            await CheckAsync(28);
            button.ButtonSize = MuiButtonSize.Md;
            await CheckAsync(36);

            var source = new Slider { Minimum = 0, Maximum = 100, Value = 60 };
            button.SetBinding(FrameworkElement.MinHeightProperty, new Binding
            {
                Source = source, Path = new PropertyPath("Value"), Mode = BindingMode.OneWay,
            });
            await CheckAsync(60);
            button.Label = "Bound minimum";
            button.Variant = MuiButtonVariant.Primary;
            button.ButtonSize = MuiButtonSize.Sm;
            button.IsEnabled = false;
            button.IsEnabled = true;
            await CheckAsync(60);
            source.Value = 80;
            await CheckAsync(80);
            button.ClearValue(FrameworkElement.MinHeightProperty);
            await CheckAsync(28);

            var resources = Application.Current.Resources;
            var originalStyle = (Style)resources["MuiButtonGhostStyle"];
            try
            {
                var derivedStyle = new Style(typeof(MuiButton)) { BasedOn = originalStyle };
                derivedStyle.Setters.Add(new Setter { Property = FrameworkElement.TagProperty, Value = "derived-target-style" });
                resources["MuiButtonGhostStyle"] = derivedStyle;
                button.Variant = MuiButtonVariant.Ghost;
                await CheckAsync(28);
                if (!Equals(button.Tag, "derived-target-style"))
                    throw new InvalidOperationException("Button size style lost its derived base-style setter.");
            }
            finally { resources["MuiButtonGhostStyle"] = originalStyle; }
            button.Label = "Restored base style";
            await CheckAsync(28);
            if (button.Tag != null)
                throw new InvalidOperationException("Button size style retained a superseded base-style setter.");
        }
        finally { root.Children.Remove(host); }

        async Task CheckAsync(double expected)
        {
            await Task.Delay(30);
            root.UpdateLayout();
            if (Math.Abs(button.MinHeight - expected) > .5 || button.ActualHeight < expected - .5)
                throw new InvalidOperationException($"Button minimum was overwritten or not realized: expected={expected}, "
                    + $"minimum={button.MinHeight}, actual={button.ActualHeight}");
        }
    }
}
