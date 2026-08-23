using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>Progress Step status (unified-component-catalog.md §3,
    /// "Progress Step" row + `mui-progress-step.component.ts`'s
    /// <c>MuiProgressStepStatus</c>).</summary>
    public enum MuiProgressStepStatus { Pending, Active, Done }

    /// <summary>
    /// Maple.UI Progress Step molecule (unified-component-catalog.md §3,
    /// "Progress Step" row: "One step of a wizard", built from Text,
    /// Progress, Button) — an index/checkmark, a label, a status-driven
    /// progress bar (Pending: 0, Active: indeterminate, Done: 100 — ports
    /// `mui-progress-step.component.ts`'s <c>progressValue</c> computed
    /// exactly), and a Continue action while Active.
    /// </summary>
    public sealed class MuiProgressStep : ContentControl
    {
        public static readonly DependencyProperty IndexProperty =
            DependencyProperty.Register(nameof(Index), typeof(int), typeof(MuiProgressStep),
                new PropertyMetadata(0, (d, _) => ((MuiProgressStep)d).Rebuild()));

        public static readonly DependencyProperty LabelProperty =
            DependencyProperty.Register(nameof(Label), typeof(string), typeof(MuiProgressStep),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiProgressStep)d).Rebuild()));

        public static readonly DependencyProperty StatusProperty =
            DependencyProperty.Register(nameof(Status), typeof(MuiProgressStepStatus), typeof(MuiProgressStep),
                new PropertyMetadata(MuiProgressStepStatus.Pending, (d, _) => ((MuiProgressStep)d).Rebuild()));

        public static readonly DependencyProperty ContinueLabelProperty =
            DependencyProperty.Register(nameof(ContinueLabel), typeof(string), typeof(MuiProgressStep),
                new PropertyMetadata("Continue", (d, e) => ((MuiProgressStep)d)._continueButton.Label = (string)e.NewValue));

        public int Index
        {
            get => (int)GetValue(IndexProperty);
            set => SetValue(IndexProperty, value);
        }

        public string Label
        {
            get => (string)GetValue(LabelProperty);
            set => SetValue(LabelProperty, value);
        }

        public MuiProgressStepStatus Status
        {
            get => (MuiProgressStepStatus)GetValue(StatusProperty);
            set => SetValue(StatusProperty, value);
        }

        public string ContinueLabel
        {
            get => (string)GetValue(ContinueLabelProperty);
            set => SetValue(ContinueLabelProperty, value);
        }

        public event EventHandler? Continued;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 8 };
        private readonly StackPanel _headerRow = new() { Orientation = Orientation.Horizontal, Spacing = 8 };
        private readonly MuiText _indexText = new() { Variant = MuiTextVariant.ChipLabel };
        private readonly MuiText _labelText = new() { Variant = MuiTextVariant.RowLabel };
        private readonly MuiProgress _progress = new() { ProgressShape = MuiProgressShape.Bar, ProgressSize = MuiProgressSize.Sm };
        private readonly MuiButton _continueButton = new() { Variant = MuiButtonVariant.Primary, ButtonSize = MuiButtonSize.Sm, Label = "Continue" };

        public MuiProgressStep()
        {
            _headerRow.Children.Add(_indexText);
            _headerRow.Children.Add(_labelText);
            _root.Children.Add(_headerRow);
            _root.Children.Add(_progress);
            _root.Children.Add(_continueButton);
            Content = _root;
            IsTabStop = false;

            _continueButton.Click += (_, _) => Continued?.Invoke(this, EventArgs.Empty);

            Rebuild();
        }

        private void Rebuild()
        {
            _indexText.Text = Status == MuiProgressStepStatus.Done ? "✓" : (Index + 1).ToString();
            _labelText.Text = Label;

            (_progress.IsIndeterminate, _progress.Value) = Status switch
            {
                MuiProgressStepStatus.Done => (false, 100.0),
                MuiProgressStepStatus.Active => (true, 0.0),
                _ => (false, 0.0),
            };

            _continueButton.Visibility = Status == MuiProgressStepStatus.Active ? Visibility.Visible : Visibility.Collapsed;
        }
    }
}
