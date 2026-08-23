using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One label/value pair (e.g. an EXIF row: "Camera" / "Sony
    /// A7R V").</summary>
    public sealed record MuiLabelValueRow(string Label, string Value);

    /// <summary>
    /// Maple.UI Label-Value Grid molecule (unified-component-catalog.md
    /// §2.5, "Label-Value Grid" row: "Two-column metadata grid", built from
    /// Text) — a plain two-column <see cref="Grid"/> of label/value rows.
    /// Ports `mui-label-value-grid.component.ts` 1:1 — that molecule is
    /// itself just a `@for` over its rows, no extra logic of its own.
    /// </summary>
    public sealed class MuiLabelValueGrid : ContentControl
    {
        public static readonly DependencyProperty RowsProperty =
            DependencyProperty.Register(nameof(Rows), typeof(IReadOnlyList<MuiLabelValueRow>), typeof(MuiLabelValueGrid),
                new PropertyMetadata(null, (d, _) => ((MuiLabelValueGrid)d).Rebuild()));

        public IReadOnlyList<MuiLabelValueRow>? Rows
        {
            get => (IReadOnlyList<MuiLabelValueRow>?)GetValue(RowsProperty);
            set => SetValue(RowsProperty, value);
        }

        private readonly Grid _root = new() { ColumnSpacing = 16, RowSpacing = 8 };

        public MuiLabelValueGrid()
        {
            _root.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            _root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            Content = _root;
            IsTabStop = false;

            Rebuild();
        }

        private void Rebuild()
        {
            _root.RowDefinitions.Clear();
            _root.Children.Clear();

            var rows = Rows ?? Array.Empty<MuiLabelValueRow>();
            for (var i = 0; i < rows.Count; i++)
            {
                _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

                var label = new MuiText { Text = rows[i].Label, Variant = MuiTextVariant.ToolLabel, ColorRole = MuiTextColorRole.Muted };
                var value = new MuiText { Text = rows[i].Value, Variant = MuiTextVariant.RowLabel };
                Grid.SetRow(label, i);
                Grid.SetColumn(label, 0);
                Grid.SetRow(value, i);
                Grid.SetColumn(value, 1);

                _root.Children.Add(label);
                _root.Children.Add(value);
            }
        }
    }
}
