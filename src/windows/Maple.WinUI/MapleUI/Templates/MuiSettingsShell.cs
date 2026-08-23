using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Settings Shell template (unified-component-catalog.md §5,
    /// "Settings Shell" row: "Section nav · Pane", regions only) — backs
    /// the Settings and Admin pages (§6). Ports
    /// `mui-settings-shell.component.ts`'s contract: a fixed-width Nav
    /// region and a Pane region that fills the remaining space up to
    /// <see cref="PaneMaxWidth"/>, centered once the shell is wider than
    /// that cap.
    ///
    /// The "fill up to max-width, then center" behavior comes from
    /// combining a Stretch <see cref="FrameworkElement.HorizontalAlignment"/>
    /// with a capped <see cref="FrameworkElement.MaxWidth"/> on the Pane
    /// slot — WinUI's well-known equivalent of the web port's
    /// <c>width: 100%; max-width: Npx;</c> inside a
    /// <c>justify-content: center</c> flex row: a Stretch-aligned element
    /// whose effective size is capped below its layout slot's width is
    /// centered within that slot, not left-aligned.
    /// </summary>
    public sealed class MuiSettingsShell : ContentControl
    {
        public static readonly DependencyProperty NavProperty =
            DependencyProperty.Register(nameof(Nav), typeof(UIElement), typeof(MuiSettingsShell),
                new PropertyMetadata(null, (d, _) => ((MuiSettingsShell)d).Rebuild()));

        public static readonly DependencyProperty PaneProperty =
            DependencyProperty.Register(nameof(Pane), typeof(UIElement), typeof(MuiSettingsShell),
                new PropertyMetadata(null, (d, _) => ((MuiSettingsShell)d).Rebuild()));

        public static readonly DependencyProperty NavWidthProperty =
            DependencyProperty.Register(nameof(NavWidth), typeof(double), typeof(MuiSettingsShell),
                new PropertyMetadata(240.0, (d, _) => ((MuiSettingsShell)d).ApplyNavWidth()));

        public static readonly DependencyProperty PaneMaxWidthProperty =
            DependencyProperty.Register(nameof(PaneMaxWidth), typeof(double), typeof(MuiSettingsShell),
                new PropertyMetadata(640.0, (d, _) => ((MuiSettingsShell)d).ApplyPaneMaxWidth()));

        public UIElement? Nav { get => (UIElement?)GetValue(NavProperty); set => SetValue(NavProperty, value); }

        /// <summary>The default (un-named) region.</summary>
        public UIElement? Pane { get => (UIElement?)GetValue(PaneProperty); set => SetValue(PaneProperty, value); }

        public double NavWidth { get => (double)GetValue(NavWidthProperty); set => SetValue(NavWidthProperty, value); }
        public double PaneMaxWidth { get => (double)GetValue(PaneMaxWidthProperty); set => SetValue(PaneMaxWidthProperty, value); }

        private readonly Grid _root = new();
        private readonly Grid _navSlot = new();
        private readonly Grid _paneWrap = new() { HorizontalAlignment = HorizontalAlignment.Stretch };
        private readonly Grid _paneSlot = new() { HorizontalAlignment = HorizontalAlignment.Stretch };

        public MuiSettingsShell()
        {
            _root.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            _root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            Grid.SetColumn(_navSlot, 0);
            Grid.SetColumn(_paneWrap, 1);

            _paneWrap.Children.Add(_paneSlot);
            _root.Children.Add(_navSlot);
            _root.Children.Add(_paneWrap);

            Content = _root;
            IsTabStop = false;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            ApplyNavWidth();
            ApplyPaneMaxWidth();
            Rebuild();
        }

        private void ApplyNavWidth() => _navSlot.Width = NavWidth;

        private void ApplyPaneMaxWidth() => _paneSlot.MaxWidth = PaneMaxWidth;

        private void Rebuild()
        {
            _navSlot.Children.Clear();
            if (Nav is not null) _navSlot.Children.Add(Nav);

            _paneSlot.Children.Clear();
            if (Pane is not null) _paneSlot.Children.Add(Pane);
        }
    }
}
