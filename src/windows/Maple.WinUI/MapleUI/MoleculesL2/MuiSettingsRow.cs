using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Settings Row molecule (unified-component-catalog.md §3,
    /// "Settings Row" row: "Collapsible labeled setting", built from
    /// Collapsible, Icon, Text, Divider) — a leading icon plus a
    /// <see cref="MuiCollapsible"/> whose disclosed body holds an optional
    /// description and the caller's own <see cref="RowContent"/> (the
    /// WinUI stand-in for `mui-settings-row.component.html`'s
    /// <c>&lt;ng-content /&gt;</c> projection), with an optional trailing
    /// divider so a caller stacking several rows supplies it once between
    /// rows rather than doubling it up (same default-on convention the web
    /// port's <c>showDivider</c> prop uses).
    /// </summary>
    public sealed class MuiSettingsRow : ContentControl
    {
        public static readonly DependencyProperty LabelProperty =
            DependencyProperty.Register(nameof(Label), typeof(string), typeof(MuiSettingsRow),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiSettingsRow)d)._collapsible.Label = (string)e.NewValue));

        public static readonly DependencyProperty IconNameProperty =
            DependencyProperty.Register(nameof(IconName), typeof(string), typeof(MuiSettingsRow),
                new PropertyMetadata(null, (d, _) => ((MuiSettingsRow)d).Rebuild()));

        public static readonly DependencyProperty DescriptionProperty =
            DependencyProperty.Register(nameof(Description), typeof(string), typeof(MuiSettingsRow),
                new PropertyMetadata(null, (d, _) => ((MuiSettingsRow)d).Rebuild()));

        public static readonly DependencyProperty IsExpandedProperty =
            DependencyProperty.Register(nameof(IsExpanded), typeof(bool), typeof(MuiSettingsRow),
                new PropertyMetadata(false, (d, e) => ((MuiSettingsRow)d)._collapsible.IsExpanded = (bool)e.NewValue));

        public static readonly DependencyProperty RowContentProperty =
            DependencyProperty.Register(nameof(RowContent), typeof(UIElement), typeof(MuiSettingsRow),
                new PropertyMetadata(null, (d, _) => ((MuiSettingsRow)d).Rebuild()));

        public static readonly DependencyProperty ShowDividerProperty =
            DependencyProperty.Register(nameof(ShowDivider), typeof(bool), typeof(MuiSettingsRow),
                new PropertyMetadata(true, (d, _) => ((MuiSettingsRow)d).Rebuild()));

        public string Label
        {
            get => (string)GetValue(LabelProperty);
            set => SetValue(LabelProperty, value);
        }

        public string? IconName
        {
            get => (string?)GetValue(IconNameProperty);
            set => SetValue(IconNameProperty, value);
        }

        public string? Description
        {
            get => (string?)GetValue(DescriptionProperty);
            set => SetValue(DescriptionProperty, value);
        }

        public bool IsExpanded
        {
            get => (bool)GetValue(IsExpandedProperty);
            set => SetValue(IsExpandedProperty, value);
        }

        /// <summary>The setting's own control(s), disclosed below the
        /// description when expanded.</summary>
        public UIElement? RowContent
        {
            get => (UIElement?)GetValue(RowContentProperty);
            set => SetValue(RowContentProperty, value);
        }

        public bool ShowDivider
        {
            get => (bool)GetValue(ShowDividerProperty);
            set => SetValue(ShowDividerProperty, value);
        }

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 4 };
        // Auto + Star grid, NOT a horizontal StackPanel: a horizontal panel
        // measures its children with infinite width, so the collapsible's
        // description text never receives a wrapping constraint and long
        // descriptions clip at the pane edge instead of wrapping.
        // ColumnSpacing 4, not 8: the collapsible header button carries 4px
        // of its own left padding, so 4 + 4 gives the icon→chevron gap the
        // same 8px the header's chevron→label spacing uses.
        private readonly Grid _headerRow = new() { ColumnSpacing = 4 };
        private readonly MuiIcon _leadingIcon = new() { Size = MuiIconSize.Sm16 };
        private readonly MuiCollapsible _collapsible = new() { HorizontalAlignment = HorizontalAlignment.Stretch };
        private readonly StackPanel _body = new() { Orientation = Orientation.Vertical, Spacing = 8 };
        private readonly MuiText _descriptionText = new() { Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted };
        private readonly ContentPresenter _rowContentHost = new();
        private readonly MuiDivider _divider = new();

        public MuiSettingsRow()
        {
            _body.Children.Add(_descriptionText);
            _body.Children.Add(_rowContentHost);
            _collapsible.BodyContent = _body;
            _collapsible.ExpandedChanged += (_, expanded) => IsExpanded = expanded;
            _headerRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            _headerRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            Grid.SetColumn(_leadingIcon, 0);
            Grid.SetColumn(_collapsible, 1);
            // Top-aligned 32px-tall icon box: 32 is the collapsible header
            // button's height (WinUI Button MinHeight), so the glyph —
            // centered within its own box by MuiIcon — sits on the header
            // label's centerline, and stays there when the row expands
            // (centering against the whole expanded row would drift it
            // down into the body).
            _leadingIcon.Height = 32;
            _leadingIcon.VerticalAlignment = VerticalAlignment.Top;
            _headerRow.Children.Add(_leadingIcon);
            _headerRow.Children.Add(_collapsible);
            _root.Children.Add(_headerRow);
            _root.Children.Add(_divider);
            Content = _root;
            IsTabStop = false;

            Rebuild();
        }

        private void Rebuild()
        {
            _leadingIcon.IconName = IconName ?? string.Empty;
            _leadingIcon.Visibility = string.IsNullOrEmpty(IconName) ? Visibility.Collapsed : Visibility.Visible;

            _descriptionText.Text = Description ?? string.Empty;
            _descriptionText.Visibility = string.IsNullOrEmpty(Description) ? Visibility.Collapsed : Visibility.Visible;

            _rowContentHost.Content = RowContent;

            _divider.Visibility = ShowDivider ? Visibility.Visible : Visibility.Collapsed;
        }
    }
}
