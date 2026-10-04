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

            var peer = new MuiButton { Label = "Shared size style", ButtonSize = button.ButtonSize, Variant = button.Variant };
            host.Children.Add(peer);
            if (!ReferenceEquals(button.Style, peer.Style))
                throw new InvalidOperationException("Identical button variants and sizes did not reuse their style.");
            button.Padding = new Thickness(30, 14, 30, 14);
            button.FontSize = 24;
            button.ButtonSize = MuiButtonSize.Lg;
            button.Label = "Caller typography";
            button.IsLoading = true;
            button.IsLoading = false;
            await CheckTypographyAsync(new Thickness(30, 14, 30, 14), 24);
            button.ClearValue(Control.PaddingProperty);
            button.ClearValue(Control.FontSizeProperty);
            await CheckTypographyAsync(new Thickness(24, 12, 24, 12), 15);
            button.SetBinding(Control.FontSizeProperty, new Binding
            {
                Source = source, Path = new PropertyPath("Value"), Mode = BindingMode.OneWay,
            });
            source.Value = 22;
            button.ButtonSize = MuiButtonSize.Sm;
            await CheckTypographyAsync(new Thickness(8, 4, 8, 4), 22);
            source.Value = 26;
            await CheckTypographyAsync(new Thickness(8, 4, 8, 4), 26);
            button.ClearValue(Control.FontSizeProperty);
            await CheckTypographyAsync(new Thickness(8, 4, 8, 4), 11);
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

        async Task CheckTypographyAsync(Thickness padding, double fontSize)
        {
            await Task.Delay(30);
            root.UpdateLayout();
            var label = (TextBlock)((StackPanel)button.Content).Children[2];
            if (button.Padding != padding || button.FontSize != fontSize || label.FontSize != fontSize || label.ActualHeight <= 0)
                throw new InvalidOperationException("Caller typography was overwritten or not propagated to the rendered label.");
        }
    }
}
