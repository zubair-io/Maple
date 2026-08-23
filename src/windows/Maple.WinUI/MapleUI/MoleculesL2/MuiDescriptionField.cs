using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Description Field molecule (unified-component-catalog.md
    /// §3, "Description Field" row: "Text with override and regenerate",
    /// built from Text, Input, Button) — displays generated/edited
    /// description text; tapping it swaps in a <see cref="MuiInput"/> to
    /// override, and a Regenerate action requests a fresh AI-generated
    /// value from the caller. Same display/edit swap pattern
    /// <see cref="MuiInlineRenameField"/> uses, routed through the shared
    /// <see cref="MuiInlineEditLogic"/> commit rule with
    /// <c>allowEmpty: true</c> — a description, unlike a rename or a place
    /// override, is allowed to be committed empty (clearing it).
    /// </summary>
    public sealed class MuiDescriptionField : ContentControl
    {
        public static readonly DependencyProperty ValueProperty =
            DependencyProperty.Register(nameof(Value), typeof(string), typeof(MuiDescriptionField),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiDescriptionField)d).Rebuild()));

        public static readonly DependencyProperty RegeneratingProperty =
            DependencyProperty.Register(nameof(Regenerating), typeof(bool), typeof(MuiDescriptionField),
                new PropertyMetadata(false, (d, _) => ((MuiDescriptionField)d).Rebuild()));

        public static readonly DependencyProperty PlaceholderProperty =
            DependencyProperty.Register(nameof(Placeholder), typeof(string), typeof(MuiDescriptionField),
                new PropertyMetadata("No description yet.", (d, _) => ((MuiDescriptionField)d).Rebuild()));

        public string Value
        {
            get => (string)GetValue(ValueProperty);
            set => SetValue(ValueProperty, value);
        }

        public bool Regenerating
        {
            get => (bool)GetValue(RegeneratingProperty);
            set => SetValue(RegeneratingProperty, value);
        }

        public string Placeholder
        {
            get => (string)GetValue(PlaceholderProperty);
            set => SetValue(PlaceholderProperty, value);
        }

        public event EventHandler? Regenerate;
        public event EventHandler<string>? Committed;

        private readonly Grid _root = new() { ColumnSpacing = 8 };
        private readonly Border _displayHit = new() { Padding = new Thickness(2), CornerRadius = new CornerRadius(4) };
        private readonly MuiText _displayText = new() { Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted };
        private readonly MuiInput _input = new();
        private readonly MuiButton _regenerateButton = new()
        {
            Variant = MuiButtonVariant.Ghost,
            ButtonSize = MuiButtonSize.Sm,
            IconName = "smart-source-wand",
            Label = "Regenerate",
            VerticalAlignment = VerticalAlignment.Top,
        };

        private bool _editing;

        public MuiDescriptionField()
        {
            _displayHit.Child = _displayText;
            _root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            _root.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            Grid.SetColumn(_displayHit, 0);
            Grid.SetColumn(_input, 0);
            Grid.SetColumn(_regenerateButton, 1);
            _root.Children.Add(_displayHit);
            _root.Children.Add(_input);
            _root.Children.Add(_regenerateButton);
            Content = _root;
            IsTabStop = false;

            _displayHit.Tapped += (_, _) => StartEditing();
            _input.Committed += (_, text) => Commit(text);
            _input.KeyDown += OnInputKeyDown;
            _regenerateButton.Click += (_, _) => Regenerate?.Invoke(this, EventArgs.Empty);

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void StartEditing()
        {
            if (_editing) return;
            _input.Text = Value;
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
            var next = MuiInlineEditLogic.ResolveCommit(rawText, Value, allowEmpty: true);
            if (next is null) return;
            Value = next;
            Committed?.Invoke(this, next);
        }

        private void Rebuild()
        {
            _displayText.Text = string.IsNullOrEmpty(Value) ? Placeholder : Value;
            _displayHit.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);

            _displayHit.Visibility = _editing ? Visibility.Collapsed : Visibility.Visible;
            _input.Visibility = _editing ? Visibility.Visible : Visibility.Collapsed;

            _regenerateButton.IsLoading = Regenerating;
        }
    }
}
