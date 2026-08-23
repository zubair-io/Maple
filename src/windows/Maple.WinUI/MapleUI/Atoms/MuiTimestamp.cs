using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Maple.UI.Atoms
{
    /// <summary>
    /// Maple.UI Timestamp atom (docs/design/maple-ui/components/timestamp.md)
    /// — a formatted date/time. The date-math lives in
    /// <see cref="MuiTimestampFormatter"/> (a plain, WinUI-free class with
    /// its own unit tests in Maple.WinUI.Tests); this control just renders
    /// that string and keeps the always-on absolute-time tooltip in sync.
    /// </summary>
    public sealed class MuiTimestamp : ContentControl
    {
        public static readonly DependencyProperty ValueProperty =
            DependencyProperty.Register(nameof(Value), typeof(DateTimeOffset?), typeof(MuiTimestamp),
                new PropertyMetadata(null, (d, _) => ((MuiTimestamp)d).Rebuild()));

        public static readonly DependencyProperty FormatProperty =
            DependencyProperty.Register(nameof(Format), typeof(MuiTimestampFormat), typeof(MuiTimestamp),
                new PropertyMetadata(MuiTimestampFormat.Relative, (d, _) => ((MuiTimestamp)d).Rebuild()));

        public static readonly DependencyProperty NowProperty =
            DependencyProperty.Register(nameof(Now), typeof(DateTimeOffset?), typeof(MuiTimestamp),
                new PropertyMetadata(null, (d, _) => ((MuiTimestamp)d).Rebuild()));

        /// <summary>The point in time to render. Required.</summary>
        public DateTimeOffset? Value
        {
            get => (DateTimeOffset?)GetValue(ValueProperty);
            set => SetValue(ValueProperty, value);
        }

        public MuiTimestampFormat Format
        {
            get => (MuiTimestampFormat)GetValue(FormatProperty);
            set => SetValue(FormatProperty, value);
        }

        /// <summary>Reference "current time" for relative formatting.
        /// Defaults to the real clock when null — exists so a host with a
        /// frozen "now" already in hand can pass it through for deterministic
        /// output (timestamp.md § Props).</summary>
        public DateTimeOffset? Now
        {
            get => (DateTimeOffset?)GetValue(NowProperty);
            set => SetValue(NowProperty, value);
        }

        private readonly TextBlock _inner = new();

        public MuiTimestamp()
        {
            _inner.Style = (Style)Application.Current.Resources["MuiTimestampStyle"];
            Content = _inner;
            IsTabStop = false;
            Rebuild();
        }

        private void Rebuild()
        {
            if (Value is not { } value)
            {
                _inner.Text = string.Empty;
                ToolTipService.SetToolTip(_inner, null);
                return;
            }

            var now = Now ?? DateTimeOffset.Now;
            _inner.Text = MuiTimestampFormatter.Format(value, Format, now);
            ToolTipService.SetToolTip(_inner, MuiTimestampFormatter.FormatAbsoluteTooltip(value));
        }
    }
}
