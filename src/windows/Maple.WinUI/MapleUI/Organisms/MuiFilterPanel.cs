using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One selectable value within a filter facet.</summary>
    public sealed record MuiFilterOption(string Id, string Label, int? Count = null);

    /// <summary>One faceted filter group (e.g. "Camera", "Rating").</summary>
    public sealed record MuiFilterFacet(string Id, string Label, IReadOnlyList<MuiFilterOption> Options);

    /// <summary>
    /// Maple.UI Filter Panel organism (unified-component-catalog.md §4.2,
    /// "Filter Panel" row: "Faceted multi-select filters", built from
    /// Collapsible, Chip Row, Checkbox, Form Field) — one
    /// <see cref="MuiCollapsible"/> per facet, each holding one
    /// <see cref="MuiCheckbox"/> per option (a Form Field label wraps the
    /// whole facet). The currently-selected options across every facet
    /// surface above the list as a single removable <see cref="MuiChipRow"/>
    /// — clearing a chip there clears that one option without expanding
    /// its facet.
    /// </summary>
    public sealed class MuiFilterPanel : ContentControl
    {
        public static readonly DependencyProperty FacetsProperty =
            DependencyProperty.Register(nameof(Facets), typeof(IReadOnlyList<MuiFilterFacet>), typeof(MuiFilterPanel),
                new PropertyMetadata(null, (d, _) => ((MuiFilterPanel)d).Rebuild()));

        public static readonly DependencyProperty SelectedOptionIdsProperty =
            DependencyProperty.Register(nameof(SelectedOptionIds), typeof(IReadOnlyList<string>), typeof(MuiFilterPanel),
                new PropertyMetadata(null, (d, _) => ((MuiFilterPanel)d).Rebuild()));

        public IReadOnlyList<MuiFilterFacet>? Facets
        {
            get => (IReadOnlyList<MuiFilterFacet>?)GetValue(FacetsProperty);
            set => SetValue(FacetsProperty, value);
        }

        public IReadOnlyList<string>? SelectedOptionIds
        {
            get => (IReadOnlyList<string>?)GetValue(SelectedOptionIdsProperty);
            set => SetValue(SelectedOptionIdsProperty, value);
        }

        /// <summary>Fires with the full recomputed selection whenever an
        /// option is toggled (in a facet or removed from the summary
        /// chip row).</summary>
        public event EventHandler<IReadOnlyList<string>>? SelectionChanged;

        public event EventHandler? ClearAllRequested;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 12 };
        private readonly MuiChipRow _summaryChips = new() { Mode = MuiChipRowMode.Removable };
        private readonly MuiButton _clearAll = new() { Variant = MuiButtonVariant.Ghost, Label = "Clear all" };
        private readonly StackPanel _facetsPanel = new() { Orientation = Orientation.Vertical, Spacing = 4 };
        private readonly Dictionary<string, MuiFilterOption> _optionsById = new();

        public MuiFilterPanel()
        {
            _root.Children.Add(_summaryChips);
            _root.Children.Add(_clearAll);
            _root.Children.Add(_facetsPanel);
            Content = _root;

            _summaryChips.Removed += (_, optionId) => Toggle(optionId, false);
            _clearAll.Click += (_, _) => ClearAllRequested?.Invoke(this, EventArgs.Empty);

            Rebuild();
        }

        private void Rebuild()
        {
            var facets = Facets ?? Array.Empty<MuiFilterFacet>();
            var selected = SelectedOptionIds is null ? new HashSet<string>() : new HashSet<string>(SelectedOptionIds);

            _optionsById.Clear();
            foreach (var option in facets.SelectMany(f => f.Options))
                _optionsById[option.Id] = option;

            _summaryChips.Chips = selected.Select(id => new MuiChip(id, _optionsById.TryGetValue(id, out var o) ? o.Label : id)).ToList();
            _summaryChips.Visibility = selected.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
            _clearAll.Visibility = selected.Count > 0 ? Visibility.Visible : Visibility.Collapsed;

            _facetsPanel.Children.Clear();
            foreach (var facet in facets)
            {
                var options = new StackPanel { Orientation = Orientation.Vertical, Spacing = 6 };
                foreach (var option in facet.Options)
                {
                    var label = option.Count.HasValue ? $"{option.Label} ({option.Count})" : option.Label;
                    var checkbox = new MuiCheckbox { Label = label, CheckedState = selected.Contains(option.Id) };
                    var optionId = option.Id;
                    checkbox.Checked += (_, _) => Toggle(optionId, true);
                    checkbox.Unchecked += (_, _) => Toggle(optionId, false);
                    options.Children.Add(checkbox);
                }

                _facetsPanel.Children.Add(new MuiCollapsible
                {
                    Label = facet.Label,
                    IsExpanded = true,
                    BodyContent = options,
                });
            }
        }

        private void Toggle(string optionId, bool selected)
        {
            var current = SelectedOptionIds is null ? new HashSet<string>() : new HashSet<string>(SelectedOptionIds);
            if (selected) current.Add(optionId); else current.Remove(optionId);
            SelectionChanged?.Invoke(this, current.ToList());
        }
    }
}
