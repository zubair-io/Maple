using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI
{
    /// <summary>One slider inside an Adjustments Panel tool group.</summary>
    public sealed record MuiAdjustmentSlider(
        string Id, string Label, double Value, double Minimum, double Maximum,
        double Step = 1, string Unit = "", bool Bipolar = false);

    /// <summary>One collapsible tool group (e.g. "Light", "Color") within
    /// a category tab.</summary>
    public sealed record MuiAdjustmentGroup(string Id, string Label, IReadOnlyList<MuiAdjustmentSlider> Sliders);

    /// <summary>One top-level tab (e.g. "Basic", "Detail").</summary>
    public sealed record MuiAdjustmentCategory(string Id, string Label, IReadOnlyList<MuiAdjustmentGroup> Groups);

    /// <summary>
    /// Maple.UI Adjustments Panel organism (unified-component-catalog.md
    /// §4.3, "Adjustments Panel" row: "All tool-group sliders", built
    /// from Living Slider, Collapsible, Tabs) — a <see cref="MuiTabs"/>
    /// strip switches between top-level categories (Basic/Detail/…);
    /// within the active category, one <see cref="MuiCollapsible"/> per
    /// tool group holds that group's <see cref="MuiLivingSlider"/>s,
    /// using Maple's own slider names (Exposure, Contrast, Highlights,
    /// Shadows, Whites, Blacks, Texture, Clarity, Dehaze, Vibrance,
    /// Saturation, …) rather than placeholder labels.
    /// </summary>
    public sealed class MuiAdjustmentsPanel : ContentControl
    {
        public static readonly DependencyProperty CategoriesProperty =
            DependencyProperty.Register(nameof(Categories), typeof(IReadOnlyList<MuiAdjustmentCategory>), typeof(MuiAdjustmentsPanel),
                new PropertyMetadata(null, (d, _) => ((MuiAdjustmentsPanel)d).Rebuild()));

        public static readonly DependencyProperty ActiveCategoryIdProperty =
            DependencyProperty.Register(nameof(ActiveCategoryId), typeof(string), typeof(MuiAdjustmentsPanel),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiAdjustmentsPanel)d).Rebuild()));

        public IReadOnlyList<MuiAdjustmentCategory>? Categories
        {
            get => (IReadOnlyList<MuiAdjustmentCategory>?)GetValue(CategoriesProperty);
            set => SetValue(CategoriesProperty, value);
        }

        public string ActiveCategoryId
        {
            get => (string)GetValue(ActiveCategoryIdProperty);
            set => SetValue(ActiveCategoryIdProperty, value);
        }

        public event EventHandler<string>? CategoryChanged;
        public event EventHandler<(string SliderId, double Value)>? ValueChanged;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 12 };
        private readonly MuiTabs _tabs = new();
        private readonly StackPanel _groups = new() { Orientation = Orientation.Vertical, Spacing = 4 };
        private readonly Dictionary<string, bool> _groupExpanded = new();

        public MuiAdjustmentsPanel()
        {
            _root.Children.Add(_tabs);
            _root.Children.Add(_groups);
            Content = _root;

            _tabs.SelectionChanged += (_, id) => { ActiveCategoryId = id; CategoryChanged?.Invoke(this, id); };

            Rebuild();
        }

        private void Rebuild()
        {
            var categories = Categories ?? Array.Empty<MuiAdjustmentCategory>();
            var tabs = new List<MuiTab>();
            foreach (var category in categories)
                tabs.Add(new MuiTab(category.Id, category.Label));
            _tabs.Tabs = tabs;
            _tabs.ActiveId = ActiveCategoryId;

            _groups.Children.Clear();
            MuiAdjustmentCategory? active = null;
            foreach (var category in categories)
                if (category.Id == ActiveCategoryId) active = category;
            active ??= categories.Count > 0 ? categories[0] : null;
            if (active is null) return;

            foreach (var group in active.Groups)
            {
                var sliders = new StackPanel { Orientation = Orientation.Vertical, Spacing = 14 };
                foreach (var spec in group.Sliders)
                {
                    var slider = new MuiLivingSlider
                    {
                        Label = spec.Label,
                        Value = spec.Value,
                        Minimum = spec.Minimum,
                        Maximum = spec.Maximum,
                        Step = spec.Step,
                        Unit = spec.Unit,
                        Bipolar = spec.Bipolar,
                    };
                    var sliderId = spec.Id;
                    slider.ValueChanged += (_, value) => ValueChanged?.Invoke(this, (sliderId, value));
                    sliders.Children.Add(slider);
                }

                var groupId = group.Id;
                var collapsible = new MuiCollapsible
                {
                    Label = group.Label,
                    IsExpanded = !_groupExpanded.TryGetValue(groupId, out var expandedState) || expandedState,
                    BodyContent = sliders,
                };
                collapsible.ExpandedChanged += (_, expanded) => _groupExpanded[groupId] = expanded;
                _groups.Children.Add(collapsible);
            }
        }
    }
}
