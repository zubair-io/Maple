using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>Outcome of one item in a completed batch operation.</summary>
    public enum MuiResultOutcome { Success, Skipped, Failed }

    /// <summary>One row of a Result Report.</summary>
    public sealed record MuiResultItem(string Id, string Label, MuiResultOutcome Outcome, string? Detail = null);

    /// <summary>
    /// Maple.UI Result Report modal organism (unified-component-catalog.md
    /// §4.4, "Result Report" row: "Per-item batch outcome", built from
    /// List Row, Badge, Empty State) — one <see cref="MuiListRow"/> per
    /// item with an outcome <see cref="MuiBadge"/>, or a
    /// <see cref="MuiEmptyState"/> when nothing ran.
    /// </summary>
    public sealed class MuiResultReportModal : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiResultReportModal),
                new PropertyMetadata(false, (d, e) => ((MuiResultReportModal)d)._shell.IsOpen = (bool)e.NewValue));

        public static readonly DependencyProperty ContainedProperty =
            DependencyProperty.Register(nameof(Contained), typeof(bool), typeof(MuiResultReportModal),
                new PropertyMetadata(false, (d, e) => ((MuiResultReportModal)d)._shell.Contained = (bool)e.NewValue));

        public static readonly DependencyProperty ItemsProperty =
            DependencyProperty.Register(nameof(Items), typeof(IReadOnlyList<MuiResultItem>), typeof(MuiResultReportModal),
                new PropertyMetadata(null, (d, _) => ((MuiResultReportModal)d).Rebuild()));

        public bool IsOpen { get => (bool)GetValue(IsOpenProperty); set => SetValue(IsOpenProperty, value); }
        public bool Contained { get => (bool)GetValue(ContainedProperty); set => SetValue(ContainedProperty, value); }

        public IReadOnlyList<MuiResultItem>? Items
        {
            get => (IReadOnlyList<MuiResultItem>?)GetValue(ItemsProperty);
            set => SetValue(ItemsProperty, value);
        }

        public event EventHandler? Dismissed;

        private readonly MuiOverlayShell _shell = new() { Size = MuiOverlayShellSize.Md, AriaLabel = "Result Report" };
        private readonly MuiText _summary = new() { Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted };
        private readonly StackPanel _rows = new() { Orientation = Orientation.Vertical, Spacing = 2 };
        private readonly MuiEmptyState _empty = new() { IconName = "check", Title = "Nothing to report" };
        private readonly MuiButton _close = new() { Variant = MuiButtonVariant.Primary, Label = "Done" };

        public MuiResultReportModal()
        {
            var body = new StackPanel { Orientation = Orientation.Vertical, Spacing = 10 };
            body.Children.Add(_summary);
            body.Children.Add(_rows);
            body.Children.Add(_empty);

            var footer = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
            footer.Children.Add(_close);

            _shell.Header = new MuiText { Text = "Result Report", Variant = MuiTextVariant.SheetTitle };
            _shell.Body = body;
            _shell.Footer = footer;
            Content = _shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _shell.Dismissed += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _close.Click += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };

            Rebuild();
        }

        private void Rebuild()
        {
            var items = Items ?? Array.Empty<MuiResultItem>();
            _empty.Visibility = items.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            _rows.Visibility = items.Count > 0 ? Visibility.Visible : Visibility.Collapsed;

            var succeeded = 0;
            var failed = 0;
            foreach (var item in items)
            {
                if (item.Outcome == MuiResultOutcome.Success) succeeded++;
                else if (item.Outcome == MuiResultOutcome.Failed) failed++;
            }
            _summary.Text = items.Count == 0 ? string.Empty : $"{succeeded} of {items.Count} succeeded" + (failed > 0 ? $", {failed} failed" : string.Empty);

            _rows.Children.Clear();
            foreach (var item in items)
            {
                var badge = new MuiBadge
                {
                    Variant = MuiBadgeVariant.Signal,
                    Value = item.Outcome switch { MuiResultOutcome.Success => "Success", MuiResultOutcome.Skipped => "Skipped", _ => "Failed" },
                };
                var trailing = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
                if (!string.IsNullOrEmpty(item.Detail))
                    trailing.Children.Add(new MuiText { Text = item.Detail, Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted });
                trailing.Children.Add(badge);
                _rows.Children.Add(new MuiListRow { Label = item.Label, TrailingContent = trailing });
            }
        }
    }
}
