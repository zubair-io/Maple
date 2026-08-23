using System;

namespace Maple.UI
{
    /// <summary>
    /// Plain, WinUI-free play/pause/scrub/mm:ss transport state shared by
    /// the Maple.UI Video Player and Audio Player molecules (unified-
    /// component-catalog.md §2.7). Ports `internal/media-transport.ts`'s
    /// functions (<c>formatDuration</c>, <c>computeProgressPercent</c>,
    /// <c>computeSeekTime</c>, <c>toggleMediaPlayback</c>) plus the
    /// playing/currentTime/duration signal trio `MediaTransportBase` wraps
    /// them in, as one plain C# class the control binds to.
    ///
    /// This wave's molecules are presentational specimens — no decoder is
    /// wired up (the catalog's own "Built from: Button, Progress, Timestamp"
    /// row for both molecules names no media-decode primitive, and neither
    /// platform's own port decodes real media inside the design-system
    /// layer). <see cref="TogglePlay"/>/<see cref="SeekToRatio"/> only flip
    /// this state and let the control's own visuals react; a host that
    /// wires up real playback later drives <see cref="SetPlaying"/>/
    /// <see cref="SetPosition"/>/<see cref="SetDuration"/> from its own
    /// media element's callbacks (the exact seam `MediaTransportBase`'s
    /// `onPlay`/`onTimeUpdate`/`onLoadedMetadata` sit at on the web side).
    /// </summary>
    public sealed class MediaTransportState
    {
        public bool IsPlaying { get; private set; }
        public double CurrentTimeSeconds { get; private set; }
        public double DurationSeconds { get; private set; }

        /// <summary>Fires after any state change below.</summary>
        public event EventHandler? Changed;

        public void SetDuration(double seconds)
        {
            var clamped = Math.Max(0, seconds);
            if (DurationSeconds.Equals(clamped)) return;
            DurationSeconds = clamped;
            CurrentTimeSeconds = Math.Min(CurrentTimeSeconds, DurationSeconds);
            Changed?.Invoke(this, EventArgs.Empty);
        }

        public void SetPlaying(bool playing)
        {
            if (IsPlaying == playing) return;
            IsPlaying = playing;
            Changed?.Invoke(this, EventArgs.Empty);
        }

        /// <summary>Plays if paused, pauses if playing. Ports
        /// `toggleMediaPlayback`.</summary>
        public void TogglePlay() => SetPlaying(!IsPlaying);

        /// <summary>Sets the current playback position, clamped into
        /// [0, Duration].</summary>
        public void SetPosition(double seconds)
        {
            var clamped = Math.Max(0, Math.Min(DurationSeconds, seconds));
            if (CurrentTimeSeconds.Equals(clamped)) return;
            CurrentTimeSeconds = clamped;
            Changed?.Invoke(this, EventArgs.Empty);
        }

        /// <summary>Ports `computeSeekTime`: converts a click's fractional
        /// position along the scrubber track (0..1) into a target position
        /// and applies it. A no-op while there's no duration to seek within
        /// yet (metadata hasn't "loaded").</summary>
        public void SeekToRatio(double ratio)
        {
            if (DurationSeconds <= 0) return;
            SetPosition(MediaTransportMath.Clamp01(ratio) * DurationSeconds);
        }

        public double ProgressPercent => MediaTransportMath.ComputeProgressPercent(CurrentTimeSeconds, DurationSeconds);

        public string FormattedCurrentTime => MediaTransportMath.FormatDuration(CurrentTimeSeconds);
        public string FormattedDuration => MediaTransportMath.FormatDuration(DurationSeconds);
    }

    /// <summary>The pure numeric half of <see cref="MediaTransportState"/> —
    /// split out so every branch is directly unit-testable without
    /// constructing the stateful wrapper.</summary>
    public static class MediaTransportMath
    {
        public static double Clamp01(double v) => Math.Max(0, Math.Min(1, v));

        /// <summary>Formats elapsed/duration seconds as m:ss — never
        /// h:mm:ss, Maple's transport clips are all sub-hour (matches
        /// `formatDuration`). Non-finite or negative input reads as
        /// "0:00".</summary>
        public static string FormatDuration(double seconds)
        {
            if (double.IsNaN(seconds) || double.IsInfinity(seconds) || seconds < 0) return "0:00";
            var total = (int)Math.Floor(seconds);
            var mins = total / 60;
            var secs = total % 60;
            return $"{mins}:{secs:D2}";
        }

        public static double ComputeProgressPercent(double currentTime, double duration) =>
            duration > 0 ? currentTime / duration * 100 : 0;
    }
}
