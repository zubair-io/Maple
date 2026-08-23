using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Frame-time HUD molecule (unified-component-catalog.md
    /// §2.3, "Frame-time HUD" row: "Performance readout overlay", built
    /// from Text only) — color-codes against Maple's own perf invariants
    /// (CLAUDE.md: 16ms slider-tick target, 50ms hard limit) via
    /// <see cref="MuiFrameTimeClassifier"/>, so the HUD flags a budget
    /// breach rather than just reporting a bare number.
    ///
    /// Ports `mui-frame-time-hud.component.ts` 1:1, driven entirely by the
    /// shared, unit-tested classifier rather than duplicating the
    /// good/warn/bad thresholds here.
    /// </summary>
    public sealed class MuiFrameTimeHud : ContentControl
    {
        public static readonly DependencyProperty FrameMsProperty =
            DependencyProperty.Register(nameof(FrameMs), typeof(double), typeof(MuiFrameTimeHud),
                new PropertyMetadata(0.0, (d, _) => ((MuiFrameTimeHud)d).Rebuild()));

        public static readonly DependencyProperty FpsProperty =
            DependencyProperty.Register(nameof(Fps), typeof(double?), typeof(MuiFrameTimeHud),
                new PropertyMetadata(null, (d, _) => ((MuiFrameTimeHud)d).Rebuild()));

        public static readonly DependencyProperty BudgetMsProperty =
            DependencyProperty.Register(nameof(BudgetMs), typeof(double), typeof(MuiFrameTimeHud),
                new PropertyMetadata(MuiFrameTimeClassifier.DefaultBudgetMs, (d, _) => ((MuiFrameTimeHud)d).Rebuild()));

        public static readonly DependencyProperty HardLimitMsProperty =
            DependencyProperty.Register(nameof(HardLimitMs), typeof(double), typeof(MuiFrameTimeHud),
                new PropertyMetadata(MuiFrameTimeClassifier.DefaultHardLimitMs, (d, _) => ((MuiFrameTimeHud)d).Rebuild()));

        public double FrameMs
        {
            get => (double)GetValue(FrameMsProperty);
            set => SetValue(FrameMsProperty, value);
        }

        /// <summary>Defaults to 1000 / FrameMs, rounded, when unset.</summary>
        public double? Fps
        {
            get => (double?)GetValue(FpsProperty);
            set => SetValue(FpsProperty, value);
        }

        /// <summary>Target frame budget in ms — at/under this is Good.</summary>
        public double BudgetMs
        {
            get => (double)GetValue(BudgetMsProperty);
            set => SetValue(BudgetMsProperty, value);
        }

        /// <summary>Hard limit in ms — over this is Bad; between budget and
        /// this is Warn.</summary>
        public double HardLimitMs
        {
            get => (double)GetValue(HardLimitMsProperty);
            set => SetValue(HardLimitMsProperty, value);
        }

        private readonly StackPanel _root = new() { Orientation = Orientation.Horizontal, Spacing = 8 };
        private readonly MuiText _fpsText = new() { Variant = MuiTextVariant.ValueChip };
        private readonly MuiText _frameMsText = new() { Variant = MuiTextVariant.ValueChip };

        public MuiFrameTimeHud()
        {
            _root.Children.Add(_fpsText);
            _root.Children.Add(_frameMsText);
            Content = _root;
            IsTabStop = false;
            IsHitTestVisible = false;

            Rebuild();
        }

        private void Rebuild()
        {
            var fps = MuiFrameTimeClassifier.ComputeFps(FrameMs, Fps);
            var status = MuiFrameTimeClassifier.Classify(FrameMs, BudgetMs, HardLimitMs);
            var colorRole = status switch
            {
                MuiFrameTimeStatus.Bad => MuiTextColorRole.Error,
                MuiFrameTimeStatus.Warn => MuiTextColorRole.Warning,
                _ => MuiTextColorRole.Success,
            };

            _fpsText.Text = $"{fps:0} fps";
            _fpsText.ColorRole = colorRole;

            _frameMsText.Text = $"{FrameMs:0.0} ms";
            _frameMsText.ColorRole = colorRole;

            var statusName = status switch
            {
                MuiFrameTimeStatus.Bad => "over budget",
                MuiFrameTimeStatus.Warn => "near budget",
                _ => "within budget",
            };
            AutomationProperties.SetName(this, $"{fps:0} frames per second, {FrameMs:0.0} milliseconds, {statusName}");
        }
    }
}
