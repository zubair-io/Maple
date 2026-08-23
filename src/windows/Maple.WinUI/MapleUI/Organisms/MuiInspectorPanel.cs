using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Inspector Panel organism (unified-component-catalog.md
    /// §4.3, "Inspector Panel" row: "Tabbed right-side detail region",
    /// built from Tabs, Page Header) — the generic shell every other
    /// panel in this section (§4.3) mounts inside: a
    /// <see cref="MuiPageHeader"/> above a <see cref="MuiTabs"/> strip,
    /// with the body swapped to whichever <see cref="TabContents"/> entry
    /// matches <see cref="ActiveTabId"/>. The caller supplies each tab's
    /// content (an Info Panel, Adjustments Panel, …) — this shell owns no
    /// panel-specific layout of its own.
    /// </summary>
    public sealed class MuiInspectorPanel : ContentControl
    {
        public static readonly DependencyProperty TitleProperty =
            DependencyProperty.Register(nameof(Title), typeof(string), typeof(MuiInspectorPanel),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiInspectorPanel)d)._header.Title = (string)e.NewValue));

        public static readonly DependencyProperty TabsProperty =
            DependencyProperty.Register(nameof(Tabs), typeof(IReadOnlyList<MuiTab>), typeof(MuiInspectorPanel),
                new PropertyMetadata(null, (d, _) => ((MuiInspectorPanel)d).Rebuild()));

        public static readonly DependencyProperty ActiveTabIdProperty =
            DependencyProperty.Register(nameof(ActiveTabId), typeof(string), typeof(MuiInspectorPanel),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiInspectorPanel)d).Rebuild()));

        public static readonly DependencyProperty TabContentsProperty =
            DependencyProperty.Register(nameof(TabContents), typeof(IReadOnlyDictionary<string, UIElement>), typeof(MuiInspectorPanel),
                new PropertyMetadata(null, (d, _) => ((MuiInspectorPanel)d).Rebuild()));

        public string Title { get => (string)GetValue(TitleProperty); set => SetValue(TitleProperty, value); }

        public IReadOnlyList<MuiTab>? Tabs
        {
            get => (IReadOnlyList<MuiTab>?)GetValue(TabsProperty);
            set => SetValue(TabsProperty, value);
        }

        public string ActiveTabId
        {
            get => (string)GetValue(ActiveTabIdProperty);
            set => SetValue(ActiveTabIdProperty, value);
        }

        public IReadOnlyDictionary<string, UIElement>? TabContents
        {
            get => (IReadOnlyDictionary<string, UIElement>?)GetValue(TabContentsProperty);
            set => SetValue(TabContentsProperty, value);
        }

        public event EventHandler<string>? TabChanged;
        public event EventHandler? BackRequested;
        public event EventHandler? MoreRequested;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 0 };
        private readonly MuiPageHeader _header = new() { ShowBack = true };
        private readonly MuiTabs _tabs = new();
        private readonly ContentPresenter _body = new() { Margin = new Thickness(16) };

        public MuiInspectorPanel()
        {
            _root.Children.Add(_header);
            _root.Children.Add(_tabs);
            _root.Children.Add(_body);
            Content = _root;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _header.BackRequested += (_, _) => BackRequested?.Invoke(this, EventArgs.Empty);
            _header.MoreRequested += (_, _) => MoreRequested?.Invoke(this, EventArgs.Empty);
            _tabs.SelectionChanged += (_, id) => { ActiveTabId = id; TabChanged?.Invoke(this, id); };

            Rebuild();
        }

        private void Rebuild()
        {
            _tabs.Tabs = Tabs;
            _tabs.ActiveId = ActiveTabId;
            _body.Content = TabContents is not null && TabContents.TryGetValue(ActiveTabId, out var content) ? content : null;
        }
    }
}
