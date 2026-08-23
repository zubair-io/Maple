using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One before/after row.</summary>
    public sealed record MuiPreviewItem(string Id, string Before, string After);

    /// <summary>
    /// Maple.UI Preview List molecule (unified-component-catalog.md §3,
    /// "Preview List" row: "Before → after row list", built from List Row,
    /// Text) — a stack of <see cref="MuiListRow"/>s (label = before value,
    /// trailing text = after value), the live-preview list every batch
    /// operation (Batch Rename's template preview, a Suggestion sweep)
    /// shows before it commits.
    /// </summary>
    public sealed class MuiPreviewList : ContentControl
    {
        public static readonly DependencyProperty ItemsProperty =
            DependencyProperty.Register(nameof(Items), typeof(IReadOnlyList<MuiPreviewItem>), typeof(MuiPreviewList),
                new PropertyMetadata(null, (d, _) => ((MuiPreviewList)d).Rebuild()));

        public IReadOnlyList<MuiPreviewItem>? Items
        {
            get => (IReadOnlyList<MuiPreviewItem>?)GetValue(ItemsProperty);
            set => SetValue(ItemsProperty, value);
        }

        public event EventHandler<string>? Pressed;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 0 };

        public MuiPreviewList()
        {
            Content = _root;
            IsTabStop = false;
            Rebuild();
        }

        private void Rebuild()
        {
            _root.Children.Clear();
            foreach (var item in Items ?? Array.Empty<MuiPreviewItem>())
            {
                var row = new MuiListRow
                {
                    Label = item.Before,
                    TrailingContent = new MuiText { Text = item.After, Variant = MuiTextVariant.ChipLabel, ColorRole = MuiTextColorRole.Muted, Truncate = true },
                };
                var id = item.Id;
                row.Pressed += (_, _) => Pressed?.Invoke(this, id);
                _root.Children.Add(row);
            }
        }
    }
}
