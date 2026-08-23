using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Tab Shell template (unified-component-catalog.md §5, "Tab
    /// Shell" row: "Tab bar · Content", regions only) — backs the TV
    /// Timeline page (§6). Ports `mui-tab-shell.component.ts`'s contract:
    /// a driven <see cref="MuiTabs"/> instance (not a projected region —
    /// the one exception to "regions only" per the catalog, same as the
    /// web port's own doc comment explains) stacked with a Content region,
    /// top or bottom.
    ///
    /// <see cref="MuiTabShellPlacement.Auto"/> (default) moves the tab bar
    /// to the bottom below a phone-width breakpoint
    /// (<see cref="MuiTabShellMath.PhoneBreakpointPx"/>), tracked via this
    /// control's own <see cref="FrameworkElement.SizeChanged"/> — the
    /// WinUI equivalent of the web port's CSS container query, since a
    /// desktop app has no engine-level container-query primitive to lean
    /// on. <see cref="MuiTabShellPlacement.Top"/>/<see cref="MuiTabShellPlacement.Bottom"/>
    /// force one side regardless of width.
    /// </summary>
    public sealed class MuiTabShell : ContentControl
    {
        public static readonly DependencyProperty TabsProperty =
            DependencyProperty.Register(nameof(Tabs), typeof(IReadOnlyList<MuiTab>), typeof(MuiTabShell),
                new PropertyMetadata(null, (d, _) => ((MuiTabShell)d).Rebuild()));

        public static readonly DependencyProperty ActiveIdProperty =
            DependencyProperty.Register(nameof(ActiveId), typeof(string), typeof(MuiTabShell),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiTabShell)d).ApplyActiveId()));

        public static readonly DependencyProperty AriaLabelProperty =
            DependencyProperty.Register(nameof(AriaLabel), typeof(string), typeof(MuiTabShell),
                new PropertyMetadata("Tabs", (d, _) => ((MuiTabShell)d).Rebuild()));

        public static readonly DependencyProperty PlacementProperty =
            DependencyProperty.Register(nameof(Placement), typeof(MuiTabShellPlacement), typeof(MuiTabShell),
                new PropertyMetadata(MuiTabShellPlacement.Auto, (d, _) => ((MuiTabShell)d).Layout()));

        public static readonly DependencyProperty MainContentProperty =
            DependencyProperty.Register(nameof(MainContent), typeof(UIElement), typeof(MuiTabShell),
                new PropertyMetadata(null, (d, _) => ((MuiTabShell)d).Rebuild()));

        public IReadOnlyList<MuiTab>? Tabs { get => (IReadOnlyList<MuiTab>?)GetValue(TabsProperty); set => SetValue(TabsProperty, value); }
        public string ActiveId { get => (string)GetValue(ActiveIdProperty); set => SetValue(ActiveIdProperty, value); }
        public string AriaLabel { get => (string)GetValue(AriaLabelProperty); set => SetValue(AriaLabelProperty, value); }
        public MuiTabShellPlacement Placement { get => (MuiTabShellPlacement)GetValue(PlacementProperty); set => SetValue(PlacementProperty, value); }

        /// <summary>The default (un-named) region.</summary>
        public UIElement? MainContent { get => (UIElement?)GetValue(MainContentProperty); set => SetValue(MainContentProperty, value); }

        /// <summary>Fires after a tab click/keyboard selection change.</summary>
        public event EventHandler<string>? ActiveIdChanged;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 0 };
        private readonly MuiTabs _tabsControl = new();
        private readonly Grid _contentSlot = new();

        private double _hostWidth = double.PositiveInfinity;

        public MuiTabShell()
        {
            _tabsControl.SelectionChanged += (_, id) =>
            {
                ActiveId = id;
                ActiveIdChanged?.Invoke(this, id);
            };

            Content = _root;
            IsTabStop = false;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            SizeChanged += (_, e) => { _hostWidth = e.NewSize.Width; Layout(); };

            Rebuild();
            Layout();
        }

        private void Layout()
        {
            var bottom = MuiTabShellMath.TabBarAtBottom(Placement, _hostWidth);
            _root.Children.Clear();
            if (bottom)
            {
                _root.Children.Add(_contentSlot);
                _root.Children.Add(_tabsControl);
            }
            else
            {
                _root.Children.Add(_tabsControl);
                _root.Children.Add(_contentSlot);
            }
        }

        /// <summary>Syncs an externally set <see cref="ActiveId"/> onto
        /// the driven <see cref="MuiTabs"/> instance. Separate from
        /// <see cref="Rebuild"/> so an active-id change alone never
        /// touches the region slot's children.</summary>
        private void ApplyActiveId()
        {
            if (!string.IsNullOrEmpty(ActiveId))
                _tabsControl.ActiveId = ActiveId;
        }

        private void Rebuild()
        {
            _tabsControl.Tabs = Tabs;
            _tabsControl.AriaLabel = AriaLabel;

            // MuiTabs auto-defaults its own ActiveId to the first tab when
            // ours is empty — read that resolved value back so this
            // control's own ActiveId stays in sync with what's actually
            // shown as selected.
            if (!string.IsNullOrEmpty(ActiveId))
                _tabsControl.ActiveId = ActiveId;
            else if (!string.IsNullOrEmpty(_tabsControl.ActiveId))
                ActiveId = _tabsControl.ActiveId;

            _contentSlot.Children.Clear();
            if (MainContent is not null) _contentSlot.Children.Add(MainContent);
        }
    }
}
