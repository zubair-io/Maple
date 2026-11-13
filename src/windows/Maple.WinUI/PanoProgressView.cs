using System;
using Maple.UI.Atoms;
using Maple.WinUI.Services.Pano;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.WinUI
{
    /// <summary>Progress for one maple-cli pano run (#4581): the current
    /// pipeline step, a bar that is determinate only while the step reports
    /// a fraction (matching advances unevenly and can take minutes), and a
    /// running elapsed clock so a long step still visibly moves. All
    /// members are UI-thread only.</summary>
    internal sealed class PanoProgressView
    {
        private readonly MuiProgress _bar = new() { ProgressShape = MuiProgressShape.Bar, IsIndeterminate = true };
        private readonly MuiText _status = new() { Variant = MuiTextVariant.Body, LineClamp = 4 };
        private readonly MuiText _elapsed = new() { Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted };
        private readonly DispatcherQueueTimer _clock;
        private DateTime _startedUtc;

        public PanoProgressView(DispatcherQueue queue)
        {
            Root = new StackPanel { Spacing = 6, Children = { _bar, _status, _elapsed } };
            _clock = queue.CreateTimer();
            _clock.Interval = TimeSpan.FromSeconds(1);
            _clock.Tick += (_, _) => ShowElapsed();
        }

        public StackPanel Root { get; }

        public void Start(string status)
        {
            _startedUtc = DateTime.UtcNow;
            _bar.IsIndeterminate = true;
            _bar.Value = 0;
            _bar.Visibility = Visibility.Visible;
            _elapsed.Visibility = Visibility.Visible;
            _status.Text = status;
            ShowElapsed();
            _clock.Start();
        }

        /// <summary>Show a CLI or provisioning status line.</summary>
        public void Report(string line)
        {
            var progress = PanoProgressLine.TryParse(line);
            _status.Text = progress?.Description ?? line;
            if (progress is null)
                return;
            _bar.IsIndeterminate = !progress.HasPartialFraction;
            _bar.Value = progress.Percent;
        }

        /// <summary>Stop the clock and replace the bar with a final message;
        /// the elapsed line keeps the run's duration.</summary>
        public void Finish(string status)
        {
            _clock.Stop();
            _bar.Visibility = Visibility.Collapsed;
            _status.Text = status;
        }

        public void Show(string status)
        {
            _clock.Stop();
            _bar.Visibility = Visibility.Collapsed;
            _elapsed.Visibility = Visibility.Collapsed;
            _status.Text = status;
        }

        private void ShowElapsed()
        {
            var elapsed = DateTime.UtcNow - _startedUtc;
            _elapsed.Text = $"{(int)elapsed.TotalMinutes}:{elapsed.Seconds:00} elapsed";
        }
    }
}
