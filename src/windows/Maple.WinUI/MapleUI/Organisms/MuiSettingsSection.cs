using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One row within a Settings Section. StartExpanded (MN3,
    /// #3052) discloses the row's description/content immediately — for
    /// rows whose control is the section's point (a toggle, a primary
    /// action) rather than collapsed detail.</summary>
    public sealed record MuiSettingsSectionRow(string Id, string Label, string? IconName = null, string? Description = null, UIElement? RowContent = null, bool StartExpanded = false);

    /// <summary>
    /// Maple.UI Settings Section organism (unified-component-catalog.md
    /// §4.8, "Settings Section" row: "A group of related settings", built
    /// from Settings Row, Form Field, Divider, Banner) — a section
    /// heading, an optional <see cref="MuiBanner"/> (e.g. "restart
    /// required"), and one <see cref="MuiSettingsRow"/> per setting
    /// (each row's own control is a <see cref="MuiFormField"/>-wrapped
    /// input the caller supplies), separated by <see cref="MuiDivider"/>s.
    /// </summary>
    public sealed class MuiSettingsSection : ContentControl
    {
        public static readonly DependencyProperty TitleProperty =
            DependencyProperty.Register(nameof(Title), typeof(string), typeof(MuiSettingsSection),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiSettingsSection)d).Rebuild()));

        public static readonly DependencyProperty BannerMessageProperty =
            DependencyProperty.Register(nameof(BannerMessage), typeof(string), typeof(MuiSettingsSection),
                new PropertyMetadata(null, (d, _) => ((MuiSettingsSection)d).Rebuild()));

        public static readonly DependencyProperty RowsProperty =
            DependencyProperty.Register(nameof(Rows), typeof(IReadOnlyList<MuiSettingsSectionRow>), typeof(MuiSettingsSection),
                new PropertyMetadata(null, (d, _) => ((MuiSettingsSection)d).Rebuild()));

        public string Title { get => (string)GetValue(TitleProperty); set => SetValue(TitleProperty, value); }
        public string? BannerMessage { get => (string?)GetValue(BannerMessageProperty); set => SetValue(BannerMessageProperty, value); }

        public IReadOnlyList<MuiSettingsSectionRow>? Rows
        {
            get => (IReadOnlyList<MuiSettingsSectionRow>?)GetValue(RowsProperty);
            set => SetValue(RowsProperty, value);
        }

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 10 };
        private readonly MuiText _heading = new() { Variant = MuiTextVariant.RowLabel };
        private readonly MuiBanner _banner = new() { Variant = MuiBannerVariant.Warning, Visibility = Visibility.Collapsed };
        private readonly StackPanel _rows = new() { Orientation = Orientation.Vertical, Spacing = 0 };

        public MuiSettingsSection()
        {
            _root.Children.Add(_heading);
            _root.Children.Add(_banner);
            _root.Children.Add(_rows);
            Content = _root;
            Rebuild();
        }

        private void Rebuild()
        {
            _heading.Text = Title;
            _banner.Visibility = string.IsNullOrEmpty(BannerMessage) ? Visibility.Collapsed : Visibility.Visible;
            _banner.Message = BannerMessage ?? string.Empty;

            _rows.Children.Clear();
            var rows = Rows ?? Array.Empty<MuiSettingsSectionRow>();
            for (var i = 0; i < rows.Count; i++)
            {
                var row = rows[i];
                _rows.Children.Add(new MuiSettingsRow
                {
                    Label = row.Label,
                    IconName = row.IconName,
                    Description = row.Description,
                    RowContent = row.RowContent,
                    ShowDivider = i < rows.Count - 1,
                    IsExpanded = row.StartExpanded,
                });
            }
        }
    }
}
