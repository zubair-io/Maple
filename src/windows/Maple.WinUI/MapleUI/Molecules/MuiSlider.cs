using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Slider molecule (unified-component-catalog.md §2.1,
    /// "Slider" row: "Labeled slider with numeric readout", built from
    /// Text, Input) — a native <see cref="Slider"/> (keyboard operation and
    /// screen-reader semantics for free) with a label/value-readout row
    /// above it, styled from tokens.
    ///
    /// Ports `mui-slider.component.ts`'s readout text via
    /// <see cref="MuiSliderMath.FormatSignedValue"/> — same shared math the
    /// Living Slider molecule uses, so both read out identically for the
    /// same value/step/unit.
    /// </summary>
    public sealed class MuiSlider : ContentControl
    {
        public static readonly DependencyProperty LabelProperty =
            DependencyProperty.Register(nameof(Label), typeof(string), typeof(MuiSlider),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiSlider)d).Rebuild()));

        public static readonly DependencyProperty ValueProperty =
            DependencyProperty.Register(nameof(Value), typeof(double), typeof(MuiSlider),
                new PropertyMetadata(0.0, (d, e) => ((MuiSlider)d).OnValuePropertyChanged((double)e.NewValue)));

        public static readonly DependencyProperty MinimumProperty =
            DependencyProperty.Register(nameof(Minimum), typeof(double), typeof(MuiSlider),
                new PropertyMetadata(0.0, (d, _) => ((MuiSlider)d).Rebuild()));

        public static readonly DependencyProperty MaximumProperty =
            DependencyProperty.Register(nameof(Maximum), typeof(double), typeof(MuiSlider),
                new PropertyMetadata(100.0, (d, _) => ((MuiSlider)d).Rebuild()));

        public static readonly DependencyProperty StepProperty =
            DependencyProperty.Register(nameof(Step), typeof(double), typeof(MuiSlider),
                new PropertyMetadata(1.0, (d, _) => ((MuiSlider)d).Rebuild()));

        public static readonly DependencyProperty UnitProperty =
            DependencyProperty.Register(nameof(Unit), typeof(string), typeof(MuiSlider),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiSlider)d).Rebuild()));

        public string Label
        {
            get => (string)GetValue(LabelProperty);
            set => SetValue(LabelProperty, value);
        }

        public double Value
        {
            get => (double)GetValue(ValueProperty);
            set => SetValue(ValueProperty, value);
        }

        public double Minimum
        {
            get => (double)GetValue(MinimumProperty);
            set => SetValue(MinimumProperty, value);
        }

        public double Maximum
        {
            get => (double)GetValue(MaximumProperty);
            set => SetValue(MaximumProperty, value);
        }

        public double Step
        {
            get => (double)GetValue(StepProperty);
            set => SetValue(StepProperty, value);
        }

        public string Unit
        {
            get => (string)GetValue(UnitProperty);
            set => SetValue(UnitProperty, value);
        }

        /// <summary>Fires on every value change (drag or keyboard).</summary>
        public event EventHandler<double>? ValueChanged;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 2 };
        private readonly Grid _headerRow = new();
        private readonly MuiText _labelText = new() { Variant = MuiTextVariant.RowLabel };
        private readonly MuiText _valueText = new() { Variant = MuiTextVariant.ValueChip };
        private readonly Slider _slider = new() { IsThumbToolTipEnabled = false };
        private bool _suppressSliderCallback;

        public MuiSlider()
        {
            _headerRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            _headerRow.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            Grid.SetColumn(_valueText, 1);
            _headerRow.Children.Add(_labelText);
            _headerRow.Children.Add(_valueText);
            _root.Children.Add(_headerRow);
            _root.Children.Add(_slider);
            Content = _root;
            IsTabStop = false;

            _slider.ValueChanged += (_, e) =>
            {
                if (_suppressSliderCallback) return;
                _suppressSliderCallback = true;
                Value = e.NewValue;
                _suppressSliderCallback = false;
                Rebuild();
                ValueChanged?.Invoke(this, e.NewValue);
            };
            IsEnabledChanged += (_, _) => Rebuild();

            Rebuild();
        }

        private void OnValuePropertyChanged(double value)
        {
            if (!_suppressSliderCallback)
                _slider.Value = value;
            Rebuild();
        }

        private void Rebuild()
        {
            _labelText.Text = Label;

            _slider.Minimum = Minimum;
            _slider.Maximum = Maximum;
            _slider.StepFrequency = Step > 0 ? Step : 1;
            _slider.IsEnabled = IsEnabled;
            if (Math.Abs(_slider.Value - Value) > double.Epsilon)
            {
                _suppressSliderCallback = true;
                _slider.Value = MuiSliderMath.Clamp(Value, Minimum, Maximum);
                _suppressSliderCallback = false;
            }

            _valueText.Text = MuiSliderMath.FormatSignedValue(Value, Step > 0 ? Step : 1, Unit ?? string.Empty);

            Opacity = IsEnabled ? 1.0 : 0.45;

            if (!string.IsNullOrEmpty(Label))
                AutomationProperties.SetName(_slider, Label);
        }
    }
}
