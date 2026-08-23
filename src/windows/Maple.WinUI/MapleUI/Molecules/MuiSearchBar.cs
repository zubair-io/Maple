using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Search Bar molecule (unified-component-catalog.md §2.1,
    /// "Search Bar" row: "Query pill with clear", built from Icon, Input,
    /// Button) — a MuiInput in its Search variant (which already supplies
    /// the leading search glyph and the built-in clear ("x") affordance)
    /// plus an optional trailing ghost button for a filters/action trigger.
    ///
    /// Ports `mui-search-bar.component.ts` 1:1 — that molecule is itself
    /// just an Input(Search) + an optional Button, no extra logic of its
    /// own beyond forwarding events.
    /// </summary>
    public sealed class MuiSearchBar : ContentControl
    {
        public static readonly DependencyProperty ValueProperty =
            DependencyProperty.Register(nameof(Value), typeof(string), typeof(MuiSearchBar),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiSearchBar)d).OnValuePropertyChanged((string)e.NewValue)));

        public static readonly DependencyProperty PlaceholderProperty =
            DependencyProperty.Register(nameof(Placeholder), typeof(string), typeof(MuiSearchBar),
                new PropertyMetadata("Search", (d, _) => ((MuiSearchBar)d).Rebuild()));

        public static readonly DependencyProperty ActionLabelProperty =
            DependencyProperty.Register(nameof(ActionLabel), typeof(string), typeof(MuiSearchBar),
                new PropertyMetadata(null, (d, _) => ((MuiSearchBar)d).Rebuild()));

        public static readonly DependencyProperty ActionIconNameProperty =
            DependencyProperty.Register(nameof(ActionIconName), typeof(string), typeof(MuiSearchBar),
                new PropertyMetadata(null, (d, _) => ((MuiSearchBar)d).Rebuild()));

        public string Value
        {
            get => (string)GetValue(ValueProperty);
            set => SetValue(ValueProperty, value);
        }

        public string Placeholder
        {
            get => (string)GetValue(PlaceholderProperty);
            set => SetValue(PlaceholderProperty, value);
        }

        /// <summary>Non-null renders a trailing ghost Button for a
        /// filters/action trigger distinct from the built-in clear.</summary>
        public string? ActionLabel
        {
            get => (string?)GetValue(ActionLabelProperty);
            set => SetValue(ActionLabelProperty, value);
        }

        public string? ActionIconName
        {
            get => (string?)GetValue(ActionIconNameProperty);
            set => SetValue(ActionIconNameProperty, value);
        }

        /// <summary>Fires on Enter/blur — mirrors MuiInput's own Committed.</summary>
        public event EventHandler<string>? Committed;

        /// <summary>Fires when the trailing action Button is pressed.</summary>
        public event EventHandler? ActionPressed;

        private readonly Grid _root = new();
        private readonly MuiInput _input = new() { Variant = MuiInputVariant.Search };
        private readonly MuiButton _actionButton = new() { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm };
        private bool _suppressValueCallback;

        public MuiSearchBar()
        {
            _root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            _root.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            Grid.SetColumn(_input, 0);
            Grid.SetColumn(_actionButton, 1);
            _root.Children.Add(_input);
            _root.Children.Add(_actionButton);
            Content = _root;
            IsTabStop = false;

            _input.TextChanged += (_, text) =>
            {
                _suppressValueCallback = true;
                Value = text;
                _suppressValueCallback = false;
            };
            _input.Committed += (_, text) => Committed?.Invoke(this, text);
            _actionButton.Click += (_, _) => ActionPressed?.Invoke(this, EventArgs.Empty);
            IsEnabledChanged += (_, _) => Rebuild();

            Rebuild();
        }

        private void OnValuePropertyChanged(string value)
        {
            if (!_suppressValueCallback)
                _input.Text = value ?? string.Empty;
            Rebuild();
        }

        private void Rebuild()
        {
            _input.Placeholder = Placeholder;
            _input.IsEnabled = IsEnabled;

            var hasAction = !string.IsNullOrEmpty(ActionLabel) || !string.IsNullOrEmpty(ActionIconName);
            _actionButton.Label = ActionLabel ?? string.Empty;
            _actionButton.IconName = ActionIconName;
            _actionButton.IsEnabled = IsEnabled;
            _actionButton.Visibility = hasAction ? Visibility.Visible : Visibility.Collapsed;
            _actionButton.Margin = new Thickness(8, 0, 0, 0);

            Opacity = IsEnabled ? 1.0 : 0.45;
        }
    }
}
