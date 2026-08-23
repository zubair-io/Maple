using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI
{
    /// <summary>Navigation placement for <see cref="MuiAppShell"/>.</summary>
    public enum MuiAppShellNavPlacement { Top, Side }

    /// <summary>
    /// Maple.UI App Shell template (unified-component-catalog.md §5, "App
    /// Shell" row: "Navigation · Content · Overlay", regions only) — the
    /// root page layout: a Navigation region, a Content region, and an
    /// Overlay region that stacks above both for toasts, banners, and
    /// dialogs. Ports `mui-app-shell.component.ts`'s three-slot contract.
    ///
    /// <see cref="Navigation"/>/<see cref="MainContent"/>/<see cref="Overlay"/>
    /// are exposed as plain <see cref="UIElement"/> DependencyProperties
    /// (the same "typed slot, not the inherited Content" shape
    /// <see cref="Atoms.MuiCanvasSurface.HostedContent"/> already
    /// establishes in this library) rather than reusing the inherited
    /// <see cref="ContentControl.Content"/> — this control always sets its
    /// OWN <c>Content</c> to the internally composed region tree, so
    /// <c>Content</c> itself is not a caller-facing slot here.
    ///
    /// The Overlay region is a single element (not the web port's
    /// multi-child projection) — a caller with more than one overlay
    /// occupant (e.g. a toast stack AND a banner) composes them into one
    /// panel itself before assigning it, same as
    /// <see cref="MuiToastContainer"/> already expects to be
    /// the sole occupant of a toast anchor slot elsewhere in this app.
    /// Overlay content is expected to establish its own hit-testing the way
    /// <see cref="MuiDialog"/> and
    /// <see cref="MuiToastContainer"/> already do (a live
    /// Popup bypasses this control's overlay layer entirely) — the layer
    /// itself only becomes hit-testable once something is actually
    /// assigned to <see cref="Overlay"/>, so an empty overlay never blocks
    /// clicks through to Navigation/Content beneath it.
    /// </summary>
    public sealed class MuiAppShell : ContentControl
    {
        public static readonly DependencyProperty NavigationProperty =
            DependencyProperty.Register(nameof(Navigation), typeof(UIElement), typeof(MuiAppShell),
                new PropertyMetadata(null, (d, _) => ((MuiAppShell)d).Rebuild()));

        public static readonly DependencyProperty MainContentProperty =
            DependencyProperty.Register(nameof(MainContent), typeof(UIElement), typeof(MuiAppShell),
                new PropertyMetadata(null, (d, _) => ((MuiAppShell)d).Rebuild()));

        public static readonly DependencyProperty OverlayProperty =
            DependencyProperty.Register(nameof(Overlay), typeof(UIElement), typeof(MuiAppShell),
                new PropertyMetadata(null, (d, _) => ((MuiAppShell)d).Rebuild()));

        public static readonly DependencyProperty NavPlacementProperty =
            DependencyProperty.Register(nameof(NavPlacement), typeof(MuiAppShellNavPlacement), typeof(MuiAppShell),
                new PropertyMetadata(MuiAppShellNavPlacement.Top, (d, _) => ((MuiAppShell)d).Layout()));

        /// <summary>The Navigation region — a full-width bar above Content
        /// when <see cref="NavPlacement"/> is Top (default), a rail beside
        /// Content when Side.</summary>
        public UIElement? Navigation
        {
            get => (UIElement?)GetValue(NavigationProperty);
            set => SetValue(NavigationProperty, value);
        }

        /// <summary>The default (un-named) region — everything that isn't
        /// Navigation or Overlay.</summary>
        public UIElement? MainContent
        {
            get => (UIElement?)GetValue(MainContentProperty);
            set => SetValue(MainContentProperty, value);
        }

        /// <summary>Sits above Navigation and Content regardless of where
        /// in the layout flow it would otherwise land — toasts, banners,
        /// dialogs.</summary>
        public UIElement? Overlay
        {
            get => (UIElement?)GetValue(OverlayProperty);
            set => SetValue(OverlayProperty, value);
        }

        public MuiAppShellNavPlacement NavPlacement
        {
            get => (MuiAppShellNavPlacement)GetValue(NavPlacementProperty);
            set => SetValue(NavPlacementProperty, value);
        }

        private readonly Grid _outer = new();
        private readonly Grid _shell = new();
        private readonly Grid _navSlot = new();
        private readonly Grid _contentSlot = new();
        private readonly Grid _overlaySlot = new() { IsHitTestVisible = false };

        public MuiAppShell()
        {
            _shell.Children.Add(_navSlot);
            _shell.Children.Add(_contentSlot);
            _outer.Children.Add(_shell);
            _outer.Children.Add(_overlaySlot);

            Content = _outer;
            IsTabStop = false;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            Layout();
            Rebuild();
        }

        private void Layout()
        {
            _shell.RowDefinitions.Clear();
            _shell.ColumnDefinitions.Clear();

            if (NavPlacement == MuiAppShellNavPlacement.Side)
            {
                _shell.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                _shell.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                Grid.SetRow(_navSlot, 0);
                Grid.SetColumn(_navSlot, 0);
                Grid.SetRow(_contentSlot, 0);
                Grid.SetColumn(_contentSlot, 1);
            }
            else
            {
                _shell.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
                _shell.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
                Grid.SetColumn(_navSlot, 0);
                Grid.SetRow(_navSlot, 0);
                Grid.SetColumn(_contentSlot, 0);
                Grid.SetRow(_contentSlot, 1);
            }
        }

        private void Rebuild()
        {
            _navSlot.Children.Clear();
            if (Navigation is not null) _navSlot.Children.Add(Navigation);

            _contentSlot.Children.Clear();
            if (MainContent is not null) _contentSlot.Children.Add(MainContent);

            _overlaySlot.Children.Clear();
            _overlaySlot.IsHitTestVisible = Overlay is not null;
            if (Overlay is not null) _overlaySlot.Children.Add(Overlay);
        }
    }
}
