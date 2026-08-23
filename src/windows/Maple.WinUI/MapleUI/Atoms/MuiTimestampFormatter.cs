using System;
using System.Globalization;

namespace Maple.UI.Atoms
{
    /// <summary>Timestamp display format (timestamp.md § Variants — the atom
    /// varies by format, not a stylistic branch).</summary>
    public enum MuiTimestampFormat { Relative, Short, Long, TimeOnly }

    /// <summary>
    /// Maple.UI Timestamp atom's formatting logic
    /// (docs/design/maple-ui/components/timestamp.md), split out from
    /// <see cref="MuiTimestamp"/> into a plain C# static class with zero
    /// WinUI/WinRT dependency: this project can't be compiled on this
    /// machine (no Windows build environment), so keeping the pure date math
    /// separate from anything XAML-shaped is what lets it link into
    /// Maple.WinUI.Tests (a net8.0, non-WinUI test project — see that
    /// project's .csproj header comment) and actually run in CI.
    /// </summary>
    public static class MuiTimestampFormatter
    {
        /// <summary>Formats <paramref name="value"/> relative to
        /// <paramref name="now"/> per timestamp.md's four formats.
        /// timestamp.md documents the absolute formats (Short/Long/
        /// TimeOnly) as locale-formatted, so <paramref name="culture"/>
        /// selects the locale for those three — pass <c>null</c> (the
        /// default) to fall back to <see cref="CultureInfo.CurrentCulture"/>
        /// at call time. The Relative format's wording ("2m ago", "just
        /// now", …) is fixed English regardless of <paramref
        /// name="culture"/> — timestamp.md doesn't call for translating it,
        /// only the absolute forms — though a Relative call that falls
        /// through its six-day ceiling into an absolute short date (see
        /// <see cref="FormatRelative"/>) does still honor the requested
        /// culture for that fallback date.</summary>
        public static string Format(DateTimeOffset value, MuiTimestampFormat format, DateTimeOffset now, CultureInfo? culture = null)
        {
            var effectiveCulture = culture ?? CultureInfo.CurrentCulture;
            return format switch
            {
                MuiTimestampFormat.Short => value.ToString("MMM d, yyyy", effectiveCulture),
                MuiTimestampFormat.Long => value.ToString("MMMM d, yyyy, h:mm tt", effectiveCulture),
                MuiTimestampFormat.TimeOnly => value.ToString("h:mm tt", effectiveCulture),
                _ => FormatRelative(value, now, effectiveCulture),
            };
        }

        /// <summary>Full absolute date+time — timestamp.md's "tooltip in
        /// every format" requirement, so the exact instant is always one
        /// hover away regardless of which format is displayed. Locale
        /// follows <paramref name="culture"/>, defaulting to
        /// <see cref="CultureInfo.CurrentCulture"/> when omitted, matching
        /// <see cref="Format"/>'s absolute formats.</summary>
        public static string FormatAbsoluteTooltip(DateTimeOffset value, CultureInfo? culture = null) =>
            value.ToString("MMMM d, yyyy, h:mm tt", culture ?? CultureInfo.CurrentCulture);

        /// <summary>Relative ladder: "just now" (under a minute) -> "Nm ago"
        /// (under an hour) -> "Nh ago" (under a day) -> "Nd ago" (up to a
        /// six-day ceiling) -> an absolute short date beyond that — the
        /// ceiling exists so a two-year-old photo never renders as
        /// "731d ago" (timestamp.md § Variants: Relative). The relative
        /// strings themselves are not localized (see the culture remark on
        /// <see cref="Format"/>); <paramref name="culture"/> only affects
        /// the absolute-short-date fallback past the ceiling.</summary>
        private static string FormatRelative(DateTimeOffset value, DateTimeOffset now, CultureInfo culture)
        {
            var delta = now - value;
            if (delta < TimeSpan.Zero)
                delta = TimeSpan.Zero;

            if (delta < TimeSpan.FromMinutes(1))
                return "just now";
            if (delta < TimeSpan.FromHours(1))
                return $"{(int)delta.TotalMinutes}m ago";
            if (delta < TimeSpan.FromDays(1))
                return $"{(int)delta.TotalHours}h ago";
            if (delta < TimeSpan.FromDays(7))
                return $"{(int)delta.TotalDays}d ago";

            return Format(value, MuiTimestampFormat.Short, now, culture);
        }
    }
}
