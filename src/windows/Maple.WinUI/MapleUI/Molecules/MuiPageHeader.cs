using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Page Header molecule (unified-component-catalog.md §2.5,
    /// "Page Header" row: "Title bar with back and actions", built from
    /// Button, Text, Icon) — an optional leading back action, a centered
    /// truncating title, a trailing action slot, and an optional overflow
    /// ("more") action.
    ///
    /// Ports `mui-page-header.component.ts`'s three-slot shape; the
    /// trailing actions slot is a plain object <see cref="TrailingContent"/>
    /// property rather than Angular's `&lt;ng-content select="[actions]"&gt;`
    /// projection — the same "content as a DP" shape every other Maple.UI
    /// composite (e.g. MuiCanvasSurface's HostedContent) already uses for a
    /// caller-supplied slot.
    /// </summary>
    public sealed class MuiPageHeader : ContentControl
    {
        public static readonly DependencyProperty TitleProperty =
            DependencyProperty.Register(nameof(Title), typeof(string), typeof(MuiPageHeader),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiPageHeader)d).Rebuild()));

        public static readonly DependencyProperty ShowBackProperty =
            DependencyProperty.Register(nameof(ShowBack), typeof(bool), typeof(MuiPageHeader),
                new PropertyMetadata(true, (d, _) => ((MuiPageHeader)d).Rebuild()));

        public static readonly DependencyProperty ShowMoreProperty =
            DependencyProperty.Register(nameof(ShowMore), typeof(bool), typeof(MuiPageHeader),
                new PropertyMetadata(false, (d, _) => ((MuiPageHeader)d).Rebuild()));

        public static readonly DependencyProperty TrailingContentProperty =
            DependencyProperty.Register(nameof(TrailingContent), typeof(object), typeof(MuiPageHeader),
                new PropertyMetadata(null, (d, _) => ((MuiPageHeader)d).Rebuild()));

        public string Title
        {
            get => (string)GetValue(TitleProperty);
            set => SetValue(TitleProperty, value);
        }

        public bool ShowBack
        {
            get => (bool)GetValue(ShowBackProperty);
            set => SetValue(ShowBackProperty, value);
        }

        public bool ShowMore
        {
            get => (bool)GetValue(ShowMoreProperty);
            set => SetValue(ShowMoreProperty, value);
        }

        /// <summary>The trailing actions slot (e.g. a row of
        /// <see cref="MuiActionButton"/>s). Null renders none.</summary>
        public object? TrailingContent
        {
            get => GetValue(TrailingContentProperty);
            set => SetValue(TrailingContentProperty, value);
        }

        public event EventHandler? BackRequested;
        public event EventHandler? MoreRequested;

        private readonly Grid _root = new();
        private readonly MuiButton _backButton = new() { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm, IconName = "back" };
        private readonly MuiText _titleText = new() { Variant = MuiTextVariant.SheetTitle, Truncate = true, HorizontalAlignment = HorizontalAlignment.Center };
        private readonly StackPanel _trailingRow = new() { Orientation = Orientation.Horizontal, Spacing = 6, HorizontalAlignment = HorizontalAlignment.Right };
        private readonly ContentControl _trailingHost = new() { IsTabStop = false };
        private readonly MuiButton _moreButton = new() { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm, IconName = "ellipsis-horizontal" };

        public MuiPageHeader()
        {
            _root.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            _root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            _root.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            Grid.SetColumn(_backButton, 0);
            Grid.SetColumn(_titleText, 1);
            Grid.SetColumn(_trailingRow, 2);

            _trailingRow.Children.Add(_trailingHost);
            _trailingRow.Children.Add(_moreButton);
            _root.Children.Add(_backButton);
            _root.Children.Add(_titleText);
            _root.Children.Add(_trailingRow);
            Content = _root;
            IsTabStop = false;

            AutomationProperties.SetName(_backButton, "Back");
            AutomationProperties.SetName(_moreButton, "More");

            _backButton.Click += (_, _) => BackRequested?.Invoke(this, EventArgs.Empty);
            _moreButton.Click += (_, _) => MoreRequested?.Invoke(this, EventArgs.Empty);

            Rebuild();
        }

        private void Rebuild()
        {
            _titleText.Text = Title;
            _backButton.Visibility = ShowBack ? Visibility.Visible : Visibility.Collapsed;
            _moreButton.Visibility = ShowMore ? Visibility.Visible : Visibility.Collapsed;

            _trailingHost.Content = TrailingContent;
            _trailingHost.Visibility = TrailingContent is null ? Visibility.Collapsed : Visibility.Visible;
        }
    }
}
