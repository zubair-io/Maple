using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>Live status of one worker stage (exif/thumb/describe/geocode/…).</summary>
    public sealed record MuiPipelineStage(string Id, string Label, int Done, int Total, bool Paused = false);

    /// <summary>
    /// Maple.UI Pipeline Monitor organism (unified-component-catalog.md
    /// §4.8, "Pipeline Monitor" row: "Live stage status and metrics",
    /// built from List Row, Progress, Badge, Empty State) — one
    /// <see cref="MuiListRow"/> per worker stage (exif/thumb/describe/
    /// geocode/…), each with a determinate <see cref="MuiProgress"/> and
    /// a Paused/Running <see cref="MuiBadge"/>; a
    /// <see cref="MuiEmptyState"/> stands in when no stages are
    /// registered yet.
    /// </summary>
    public sealed class MuiPipelineMonitor : ContentControl
    {
        public static readonly DependencyProperty StagesProperty =
            DependencyProperty.Register(nameof(Stages), typeof(IReadOnlyList<MuiPipelineStage>), typeof(MuiPipelineMonitor),
                new PropertyMetadata(null, (d, _) => ((MuiPipelineMonitor)d).Rebuild()));

        public IReadOnlyList<MuiPipelineStage>? Stages
        {
            get => (IReadOnlyList<MuiPipelineStage>?)GetValue(StagesProperty);
            set => SetValue(StagesProperty, value);
        }

        public event EventHandler<string>? PauseToggleRequested;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 2 };
        private readonly StackPanel _rows = new() { Orientation = Orientation.Vertical, Spacing = 2 };
        private readonly MuiEmptyState _empty = new() { IconName = "gear", Title = "No worker stages registered" };

        public MuiPipelineMonitor()
        {
            _root.Children.Add(_rows);
            _root.Children.Add(_empty);
            Content = _root;
            Rebuild();
        }

        private void Rebuild()
        {
            var stages = Stages ?? Array.Empty<MuiPipelineStage>();
            _empty.Visibility = stages.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            _rows.Visibility = stages.Count > 0 ? Visibility.Visible : Visibility.Collapsed;

            _rows.Children.Clear();
            foreach (var stage in stages)
            {
                var trailing = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10, VerticalAlignment = VerticalAlignment.Center };
                var percent = stage.Total > 0 ? 100.0 * stage.Done / stage.Total : 0;
                trailing.Children.Add(new MuiProgress { Width = 100, Value = percent, Label = $"{stage.Done}/{stage.Total}" });
                trailing.Children.Add(new MuiBadge
                {
                    Variant = MuiBadgeVariant.Signal,
                    Value = stage.Paused ? "Paused" : "Running",
                });
                var toggle = new MuiButton { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm, Label = stage.Paused ? "Resume" : "Pause" };
                var stageId = stage.Id;
                toggle.Click += (_, _) => PauseToggleRequested?.Invoke(this, stageId);
                trailing.Children.Add(toggle);

                _rows.Children.Add(new MuiListRow { Label = stage.Label, IconName = "gear", TrailingContent = trailing });
            }
        }
    }
}
