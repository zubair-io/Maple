using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One page of a Setup Wizard — its validity comes from
    /// <see cref="MuiWizardStepState"/>, its body from here.</summary>
    public sealed record MuiWizardStepContent(string Id, string Label, UIElement Body);

    /// <summary>
    /// Maple.UI Setup Wizard organism (unified-component-catalog.md
    /// §4.8, "Setup Wizard" row: "Multi-step guided configuration", built
    /// from Progress Step, Tabs, Form Field, Button) — a
    /// <see cref="MuiProgressStep"/> per step (Pending/Active/Done off
    /// <see cref="MuiSetupWizardLogic"/>'s gating), a <see cref="MuiTabs"/>
    /// strip mirroring the same steps for direct navigation to any
    /// already-reachable one, and Back/Next/Finish
    /// <see cref="MuiButton"/>s. Each step's own <see cref="MuiFormField"/>
    /// content is caller-supplied via <see cref="Steps"/>.
    /// </summary>
    public sealed class MuiSetupWizard : ContentControl
    {
        public static readonly DependencyProperty StepsProperty =
            DependencyProperty.Register(nameof(Steps), typeof(IReadOnlyList<MuiWizardStepContent>), typeof(MuiSetupWizard),
                new PropertyMetadata(null, (d, _) => ((MuiSetupWizard)d).Rebuild()));

        public static readonly DependencyProperty StepValidityProperty =
            DependencyProperty.Register(nameof(StepValidity), typeof(IReadOnlyList<bool>), typeof(MuiSetupWizard),
                new PropertyMetadata(null, (d, _) => ((MuiSetupWizard)d).Rebuild()));

        public static readonly DependencyProperty CurrentIndexProperty =
            DependencyProperty.Register(nameof(CurrentIndex), typeof(int), typeof(MuiSetupWizard),
                new PropertyMetadata(0, (d, _) => ((MuiSetupWizard)d).Rebuild()));

        public IReadOnlyList<MuiWizardStepContent>? Steps
        {
            get => (IReadOnlyList<MuiWizardStepContent>?)GetValue(StepsProperty);
            set => SetValue(StepsProperty, value);
        }

        /// <summary>Per-step validity, index-aligned with <see cref="Steps"/>.</summary>
        public IReadOnlyList<bool>? StepValidity
        {
            get => (IReadOnlyList<bool>?)GetValue(StepValidityProperty);
            set => SetValue(StepValidityProperty, value);
        }

        public int CurrentIndex { get => (int)GetValue(CurrentIndexProperty); set => SetValue(CurrentIndexProperty, value); }

        public event EventHandler<int>? StepChanged;
        public event EventHandler? Finished;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 16 };
        private readonly StackPanel _stepList = new() { Orientation = Orientation.Vertical, Spacing = 4 };
        private readonly ContentPresenter _body = new();
        private readonly StackPanel _footer = new() { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
        private readonly MuiButton _back = new() { Variant = MuiButtonVariant.Ghost, Label = "Back" };
        private readonly MuiButton _next = new() { Variant = MuiButtonVariant.Primary, Label = "Next" };

        public MuiSetupWizard()
        {
            _root.Children.Add(_stepList);
            _root.Children.Add(_body);
            _footer.Children.Add(_back);
            _footer.Children.Add(_next);
            _root.Children.Add(_footer);
            Content = _root;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;

            _back.Click += (_, _) => GoTo(MuiSetupWizardLogic.PreviousIndex(CurrentIndex));
            _next.Click += (_, _) =>
            {
                var states = StepStates();
                if (CurrentIndex == states.Count - 1) { Finished?.Invoke(this, EventArgs.Empty); return; }
                GoTo(MuiSetupWizardLogic.NextIndex(states, CurrentIndex));
            };

            Rebuild();
        }

        private void GoTo(int index)
        {
            if (index == CurrentIndex) return;
            CurrentIndex = index;
            StepChanged?.Invoke(this, index);
        }

        private IReadOnlyList<MuiWizardStepState> StepStates()
        {
            var steps = Steps ?? Array.Empty<MuiWizardStepContent>();
            var validity = StepValidity ?? Array.Empty<bool>();
            var states = new List<MuiWizardStepState>();
            for (var i = 0; i < steps.Count; i++)
                states.Add(new MuiWizardStepState(steps[i].Id, steps[i].Label, i < validity.Count && validity[i]));
            return states;
        }

        private void Rebuild()
        {
            var steps = Steps ?? Array.Empty<MuiWizardStepContent>();
            var states = StepStates();

            _stepList.Children.Clear();
            for (var i = 0; i < steps.Count; i++)
            {
                var status = i == CurrentIndex
                    ? MuiProgressStepStatus.Active
                    : i < CurrentIndex ? MuiProgressStepStatus.Done : MuiProgressStepStatus.Pending;
                var step = new MuiProgressStep { Index = i, Label = steps[i].Label, Status = status };
                step.Continued += (_, _) => GoTo(MuiSetupWizardLogic.NextIndex(states, CurrentIndex));
                _stepList.Children.Add(step);
            }

            _body.Content = CurrentIndex >= 0 && CurrentIndex < steps.Count ? steps[CurrentIndex].Body : null;

            _back.IsEnabled = CurrentIndex > 0;
            var isLast = steps.Count > 0 && CurrentIndex == steps.Count - 1;
            _next.Label = isLast ? "Finish" : "Next";
            _next.IsEnabled = MuiSetupWizardLogic.CanAdvance(states, CurrentIndex);
        }
    }
}
