using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Maple.UI
{
    /// <summary>One film look in the catalog.</summary>
    public sealed record MuiFilmLook(string Id, string CategoryId, string Title, ImageSource? Preview = null);

    /// <summary>
    /// Maple.UI Film Panel organism (unified-component-catalog.md §4.3,
    /// "Film Panel" row: "Look catalog with strength", built from Chip
    /// Row, Card, Living Slider) — a category <see cref="MuiChipRow"/>
    /// filters a wrapped grid of look <see cref="MuiCard"/>s; picking one
    /// selects it (badge shows "Applied") and reveals the Strength
    /// <see cref="MuiLivingSlider"/> beneath the grid.
    /// </summary>
    public sealed class MuiFilmPanel : ContentControl
    {
        public static readonly DependencyProperty CategoriesProperty =
            DependencyProperty.Register(nameof(Categories), typeof(IReadOnlyList<MuiChip>), typeof(MuiFilmPanel),
                new PropertyMetadata(null, (d, e) => ((MuiFilmPanel)d)._categoryChips.Chips = (IReadOnlyList<MuiChip>?)e.NewValue));

        public static readonly DependencyProperty SelectedCategoryIdProperty =
            DependencyProperty.Register(nameof(SelectedCategoryId), typeof(string), typeof(MuiFilmPanel),
                new PropertyMetadata(null, (d, _) => ((MuiFilmPanel)d).Rebuild()));

        public static readonly DependencyProperty LooksProperty =
            DependencyProperty.Register(nameof(Looks), typeof(IReadOnlyList<MuiFilmLook>), typeof(MuiFilmPanel),
                new PropertyMetadata(null, (d, _) => ((MuiFilmPanel)d).Rebuild()));

        public static readonly DependencyProperty SelectedLookIdProperty =
            DependencyProperty.Register(nameof(SelectedLookId), typeof(string), typeof(MuiFilmPanel),
                new PropertyMetadata(null, (d, _) => ((MuiFilmPanel)d).Rebuild()));

        public static readonly DependencyProperty StrengthProperty =
            DependencyProperty.Register(nameof(Strength), typeof(double), typeof(MuiFilmPanel),
                new PropertyMetadata(100.0, (d, e) => ((MuiFilmPanel)d)._strength.Value = (double)e.NewValue));

        public IReadOnlyList<MuiChip>? Categories { get => (IReadOnlyList<MuiChip>?)GetValue(CategoriesProperty); set => SetValue(CategoriesProperty, value); }
        public string? SelectedCategoryId { get => (string?)GetValue(SelectedCategoryIdProperty); set => SetValue(SelectedCategoryIdProperty, value); }
        public IReadOnlyList<MuiFilmLook>? Looks { get => (IReadOnlyList<MuiFilmLook>?)GetValue(LooksProperty); set => SetValue(LooksProperty, value); }
        public string? SelectedLookId { get => (string?)GetValue(SelectedLookIdProperty); set => SetValue(SelectedLookIdProperty, value); }
        public double Strength { get => (double)GetValue(StrengthProperty); set => SetValue(StrengthProperty, value); }

        public event EventHandler<string>? CategorySelected;
        public event EventHandler<string>? LookSelected;
        public event EventHandler<double>? StrengthChanged;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 14 };
        private readonly MuiChipRow _categoryChips = new() { Mode = MuiChipRowMode.Select };
        private readonly StackPanel _looksRows = new() { Orientation = Orientation.Vertical, Spacing = 8 };
        private readonly MuiLivingSlider _strength = new() { Label = "Strength", Minimum = 0, Maximum = 100, Unit = "%" };

        public MuiFilmPanel()
        {
            _root.Children.Add(_categoryChips);
            _root.Children.Add(_looksRows);
            _root.Children.Add(_strength);
            Content = _root;

            _categoryChips.SelectionChanged += (_, id) => { SelectedCategoryId = id; CategorySelected?.Invoke(this, id); };
            _strength.ValueChanged += (_, v) => { Strength = v; StrengthChanged?.Invoke(this, v); };

            Rebuild();
        }

        private void Rebuild()
        {
            _categoryChips.SelectedId = SelectedCategoryId;
            _strength.Visibility = string.IsNullOrEmpty(SelectedLookId) ? Visibility.Collapsed : Visibility.Visible;

            _looksRows.Children.Clear();
            var looks = Looks ?? Array.Empty<MuiFilmLook>();
            const int perRow = 3;
            StackPanel? row = null;
            var visible = 0;
            foreach (var look in looks)
            {
                if (!string.IsNullOrEmpty(SelectedCategoryId) && look.CategoryId != SelectedCategoryId) continue;
                if (visible % perRow == 0)
                {
                    row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
                    _looksRows.Children.Add(row);
                }
                var card = new MuiCard
                {
                    Title = look.Title,
                    Source = look.Preview,
                    BadgeLabel = look.Id == SelectedLookId ? "Applied" : null,
                    Width = 120,
                };
                var lookId = look.Id;
                card.Pressed += (_, _) => { SelectedLookId = lookId; LookSelected?.Invoke(this, lookId); };
                row!.Children.Add(card);
                visible++;
            }
        }
    }
}
