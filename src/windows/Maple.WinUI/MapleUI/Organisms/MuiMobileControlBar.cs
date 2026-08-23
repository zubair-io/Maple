using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Mobile Control Bar organism (unified-component-catalog.md
    /// §4.5, "Mobile Control Bar" row: "Phone bottom control stack",
    /// built from Tool Dock, Control Surface, Tabs) — the phone-width
    /// equivalent of a Sidebar + Control Surface + Inspector Panel
    /// stacked vertically instead of side by side: the armed tool's
    /// <see cref="MuiControlSurface"/> on top, a mode <see cref="MuiTabs"/>
    /// strip, and a horizontal <see cref="MuiToolDock"/> pinned along the
    /// bottom edge.
    /// </summary>
    public sealed class MuiMobileControlBar : ContentControl
    {
        public static readonly DependencyProperty ToolLabelProperty =
            DependencyProperty.Register(nameof(ToolLabel), typeof(string), typeof(MuiMobileControlBar),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiMobileControlBar)d)._surface.ToolLabel = (string)e.NewValue));

        public static readonly DependencyProperty SlidersProperty =
            DependencyProperty.Register(nameof(Sliders), typeof(IReadOnlyList<MuiAdjustmentSlider>), typeof(MuiMobileControlBar),
                new PropertyMetadata(null, (d, e) => ((MuiMobileControlBar)d)._surface.Sliders = (IReadOnlyList<MuiAdjustmentSlider>?)e.NewValue));

        public static readonly DependencyProperty ModeTabsProperty =
            DependencyProperty.Register(nameof(ModeTabs), typeof(IReadOnlyList<MuiTab>), typeof(MuiMobileControlBar),
                new PropertyMetadata(null, (d, e) => ((MuiMobileControlBar)d)._modeTabs.Tabs = (IReadOnlyList<MuiTab>?)e.NewValue));

        public static readonly DependencyProperty ActiveModeIdProperty =
            DependencyProperty.Register(nameof(ActiveModeId), typeof(string), typeof(MuiMobileControlBar),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiMobileControlBar)d)._modeTabs.ActiveId = (string)e.NewValue));

        public static readonly DependencyProperty ToolGroupsProperty =
            DependencyProperty.Register(nameof(ToolGroups), typeof(IReadOnlyList<MuiToolDockGroup>), typeof(MuiMobileControlBar),
                new PropertyMetadata(null, (d, e) => ((MuiMobileControlBar)d)._toolDock.Groups = (IReadOnlyList<MuiToolDockGroup>?)e.NewValue));

        public static readonly DependencyProperty SelectedToolIdProperty =
            DependencyProperty.Register(nameof(SelectedToolId), typeof(string), typeof(MuiMobileControlBar),
                new PropertyMetadata(null, (d, e) => ((MuiMobileControlBar)d)._toolDock.SelectedId = (string?)e.NewValue));

        public string ToolLabel { get => (string)GetValue(ToolLabelProperty); set => SetValue(ToolLabelProperty, value); }

        public IReadOnlyList<MuiAdjustmentSlider>? Sliders
        {
            get => (IReadOnlyList<MuiAdjustmentSlider>?)GetValue(SlidersProperty);
            set => SetValue(SlidersProperty, value);
        }

        public IReadOnlyList<MuiTab>? ModeTabs
        {
            get => (IReadOnlyList<MuiTab>?)GetValue(ModeTabsProperty);
            set => SetValue(ModeTabsProperty, value);
        }

        public string ActiveModeId { get => (string)GetValue(ActiveModeIdProperty); set => SetValue(ActiveModeIdProperty, value); }

        public IReadOnlyList<MuiToolDockGroup>? ToolGroups
        {
            get => (IReadOnlyList<MuiToolDockGroup>?)GetValue(ToolGroupsProperty);
            set => SetValue(ToolGroupsProperty, value);
        }

        public string? SelectedToolId { get => (string?)GetValue(SelectedToolIdProperty); set => SetValue(SelectedToolIdProperty, value); }

        public event EventHandler<string>? ModeChanged;
        public event EventHandler<(string SliderId, double Value)>? ValueChanged;
        public event EventHandler<string>? ToolSelected;

        private readonly Grid _root = new();
        private readonly MuiControlSurface _surface = new();
        private readonly MuiTabs _modeTabs = new();
        private readonly MuiToolDock _toolDock = new() { Orientation = Orientation.Horizontal };

        public MuiMobileControlBar()
        {
            _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            Grid.SetRow(_surface, 0);
            Grid.SetRow(_modeTabs, 1);
            Grid.SetRow(_toolDock, 2);
            _root.Children.Add(_surface);
            _root.Children.Add(_modeTabs);
            _root.Children.Add(_toolDock);
            Content = _root;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _modeTabs.SelectionChanged += (_, id) => { ActiveModeId = id; ModeChanged?.Invoke(this, id); };
            _surface.ValueChanged += (_, value) => ValueChanged?.Invoke(this, value);
            _toolDock.SelectionChanged += (_, id) => { SelectedToolId = id; ToolSelected?.Invoke(this, id); };
        }
    }
}
