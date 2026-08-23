using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Place Row molecule (unified-component-catalog.md §3,
    /// "Place Row" row: "Geocoded place with override", built from Text,
    /// Input, Button) — displays the resolved place name; tapping it swaps
    /// in a <see cref="MuiInput"/> to override, with a Clear action to drop
    /// the override back to the geocoded value. Same inline-edit shape as
    /// <see cref="MuiDescriptionField"/>, but through
    /// <see cref="MuiInlineEditLogic"/> with <c>allowEmpty: false</c> — a
    /// place override is never committed blank.
    /// </summary>
    public sealed class MuiPlaceRow : ContentControl
    {
        public static readonly DependencyProperty PlaceProperty =
            DependencyProperty.Register(nameof(Place), typeof(string), typeof(MuiPlaceRow),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiPlaceRow)d).Rebuild()));

        public static readonly DependencyProperty OverriddenProperty =
            DependencyProperty.Register(nameof(Overridden), typeof(bool), typeof(MuiPlaceRow),
                new PropertyMetadata(false, (d, _) => ((MuiPlaceRow)d).Rebuild()));

        public string Place
        {
            get => (string)GetValue(PlaceProperty);
            set => SetValue(PlaceProperty, value);
        }

        public bool Overridden
        {
            get => (bool)GetValue(OverriddenProperty);
            set => SetValue(OverriddenProperty, value);
        }

        public event EventHandler<string>? Committed;
        public event EventHandler? Cleared;

        private readonly StackPanel _root = new() { Orientation = Orientation.Horizontal, Spacing = 6 };
        private readonly Border _displayHit = new() { Padding = new Thickness(2), CornerRadius = new CornerRadius(4) };
        private readonly MuiText _displayText = new() { Variant = MuiTextVariant.RowLabel, Truncate = true };
        private readonly MuiInput _input = new();
        private readonly MuiButton _clearButton = new()
        {
            Variant = MuiButtonVariant.Ghost,
            ButtonSize = MuiButtonSize.Sm,
            IconName = "revert",
        };

        private bool _editing;

        public MuiPlaceRow()
        {
            _displayHit.Child = _displayText;
            _root.Children.Add(_displayHit);
            _root.Children.Add(_input);
            _root.Children.Add(_clearButton);
            Content = _root;
            IsTabStop = false;

            _displayHit.Tapped += (_, _) => StartEditing();
            _input.Committed += (_, text) => Commit(text);
            _input.KeyDown += OnInputKeyDown;
            _clearButton.Click += (_, _) => Cleared?.Invoke(this, EventArgs.Empty);

            Rebuild();
        }

        private void StartEditing()
        {
            if (_editing) return;
            _input.Text = Place;
            _editing = true;
            Rebuild();
            DispatcherQueue.TryEnqueue(() => _ = FocusManager.TryFocusAsync(_input, FocusState.Programmatic));
        }

        private void OnInputKeyDown(object sender, KeyRoutedEventArgs e)
        {
            if (e.Key != Windows.System.VirtualKey.Escape) return;
            e.Handled = true;
            _editing = false;
            Rebuild();
        }

        private void Commit(string rawText)
        {
            if (!_editing) return;
            _editing = false;
            Rebuild();
            var next = MuiInlineEditLogic.ResolveCommit(rawText, Place, allowEmpty: false);
            if (next is null) return;
            Place = next;
            Committed?.Invoke(this, next);
        }

        private void Rebuild()
        {
            _displayText.Text = string.IsNullOrEmpty(Place) ? "Unknown location" : Place;
            _displayHit.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);

            _displayHit.Visibility = _editing ? Visibility.Collapsed : Visibility.Visible;
            _input.Visibility = _editing ? Visibility.Visible : Visibility.Collapsed;
            _clearButton.Visibility = !_editing && Overridden ? Visibility.Visible : Visibility.Collapsed;
        }
    }
}
