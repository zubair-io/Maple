using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>Result of one named diagnostic check.</summary>
    public enum MuiDiagnosticStatus { NotRun, Passed, Failed }

    /// <summary>One diagnostic check and its last result.</summary>
    public sealed record MuiDiagnosticCheck(string Id, string Label, MuiDiagnosticStatus Status);

    /// <summary>
    /// Maple.UI Diagnostics organism (unified-component-catalog.md §4.8,
    /// "Diagnostics" row: "Validation runs and raw output", built from
    /// Button, Code Block, Badge) — a "Run all" <see cref="MuiButton"/>,
    /// a status <see cref="MuiBadge"/> per check, and the last run's raw
    /// output in a <see cref="MuiCodeBlock"/>.
    /// </summary>
    public sealed class MuiDiagnostics : ContentControl
    {
        public static readonly DependencyProperty ChecksProperty =
            DependencyProperty.Register(nameof(Checks), typeof(IReadOnlyList<MuiDiagnosticCheck>), typeof(MuiDiagnostics),
                new PropertyMetadata(null, (d, _) => ((MuiDiagnostics)d).Rebuild()));

        public static readonly DependencyProperty RawOutputProperty =
            DependencyProperty.Register(nameof(RawOutput), typeof(string), typeof(MuiDiagnostics),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiDiagnostics)d)._output.Code = (string)e.NewValue));

        public static readonly DependencyProperty IsRunningProperty =
            DependencyProperty.Register(nameof(IsRunning), typeof(bool), typeof(MuiDiagnostics),
                new PropertyMetadata(false, (d, _) => ((MuiDiagnostics)d).Rebuild()));

        public IReadOnlyList<MuiDiagnosticCheck>? Checks
        {
            get => (IReadOnlyList<MuiDiagnosticCheck>?)GetValue(ChecksProperty);
            set => SetValue(ChecksProperty, value);
        }

        public string RawOutput { get => (string)GetValue(RawOutputProperty); set => SetValue(RawOutputProperty, value); }
        public bool IsRunning { get => (bool)GetValue(IsRunningProperty); set => SetValue(IsRunningProperty, value); }

        public event EventHandler? RunAllRequested;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 14 };
        private readonly MuiButton _runAll = new() { Variant = MuiButtonVariant.Primary, Label = "Run all" };
        private readonly StackPanel _checkRows = new() { Orientation = Orientation.Vertical, Spacing = 6 };
        private readonly MuiCodeBlock _output = new() { Language = "text" };

        public MuiDiagnostics()
        {
            _root.Children.Add(_runAll);
            _root.Children.Add(_checkRows);
            _root.Children.Add(_output);
            Content = _root;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;

            _runAll.Click += (_, _) => RunAllRequested?.Invoke(this, EventArgs.Empty);

            Rebuild();
        }

        private void Rebuild()
        {
            _runAll.IsEnabled = !IsRunning;
            _runAll.IsLoading = IsRunning;

            _checkRows.Children.Clear();
            foreach (var check in Checks ?? Array.Empty<MuiDiagnosticCheck>())
            {
                var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
                row.Children.Add(new MuiText { Text = check.Label, Variant = MuiTextVariant.Body, Width = 220 });
                row.Children.Add(new MuiBadge
                {
                    Variant = MuiBadgeVariant.Signal,
                    Value = check.Status switch { MuiDiagnosticStatus.Passed => "Passed", MuiDiagnosticStatus.Failed => "Failed", _ => "Not run" },
                });
                _checkRows.Children.Add(row);
            }
        }
    }
}
