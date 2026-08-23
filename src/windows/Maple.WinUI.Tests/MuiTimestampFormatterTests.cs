// MuiTimestampFormatterTests — the pure date-math behind the Maple.UI
// Timestamp atom (docs/design/maple-ui/components/timestamp.md), split out
// into Maple.WinUI/MapleUI/Atoms/MuiTimestampFormatter.cs specifically so it
// has zero WinUI/WinRT dependency and can link into this net8.0 test project
// (see this project's .csproj header comment) — the MuiTimestamp control
// itself can't be exercised without a live Window, so this formatter is the
// one piece of that atom CI can actually verify.

using System;
using Maple.UI.Atoms;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiTimestampFormatterTests
    {
        private static readonly DateTimeOffset Now = new(2026, 8, 22, 15, 45, 0, TimeSpan.Zero);

        [Fact]
        public void Relative_UnderAMinute_ReturnsJustNow()
        {
            var value = Now.AddSeconds(-30);
            Assert.Equal("just now", MuiTimestampFormatter.Format(value, MuiTimestampFormat.Relative, Now));
        }

        [Fact]
        public void Relative_UnderAnHour_ReturnsMinutesAgo()
        {
            var value = Now.AddMinutes(-2);
            Assert.Equal("2m ago", MuiTimestampFormatter.Format(value, MuiTimestampFormat.Relative, Now));
        }

        [Fact]
        public void Relative_UnderADay_ReturnsHoursAgo()
        {
            var value = Now.AddHours(-3);
            Assert.Equal("3h ago", MuiTimestampFormatter.Format(value, MuiTimestampFormat.Relative, Now));
        }

        [Fact]
        public void Relative_UnderTheSixDayCeiling_ReturnsDaysAgo()
        {
            var value = Now.AddDays(-5);
            Assert.Equal("5d ago", MuiTimestampFormatter.Format(value, MuiTimestampFormat.Relative, Now));
        }

        [Fact]
        public void Relative_AtTheSixDayCeiling_StillReturnsDaysAgo()
        {
            // "up to a six-day ceiling" (timestamp.md § Variants) — 6 whole
            // days must still be the relative form, not the absolute date.
            var value = Now.AddDays(-6);
            Assert.Equal("6d ago", MuiTimestampFormatter.Format(value, MuiTimestampFormat.Relative, Now));
        }

        [Fact]
        public void Relative_PastTheSixDayCeiling_FallsBackToAbsoluteShortDate()
        {
            // A two-year-old photo must never render as "731d ago" — the
            // whole point of the ceiling (timestamp.md § Variants).
            var value = Now.AddYears(-2);
            Assert.Equal(
                MuiTimestampFormatter.Format(value, MuiTimestampFormat.Short, Now),
                MuiTimestampFormatter.Format(value, MuiTimestampFormat.Relative, Now));
        }

        [Fact]
        public void Relative_ExactlySevenDays_FallsBackToAbsoluteShortDate()
        {
            var value = Now.AddDays(-7);
            Assert.Equal(
                MuiTimestampFormatter.Format(value, MuiTimestampFormat.Short, Now),
                MuiTimestampFormatter.Format(value, MuiTimestampFormat.Relative, Now));
        }

        [Fact]
        public void Relative_FutureValue_ClampsToJustNowRatherThanGoingNegative()
        {
            var value = Now.AddMinutes(5);
            Assert.Equal("just now", MuiTimestampFormatter.Format(value, MuiTimestampFormat.Relative, Now));
        }

        [Fact]
        public void Short_RendersMonthDayYear_NoTime()
        {
            var value = new DateTimeOffset(2026, 8, 22, 15, 45, 0, TimeSpan.Zero);
            Assert.Equal("Aug 22, 2026", MuiTimestampFormatter.Format(value, MuiTimestampFormat.Short, Now));
        }

        [Fact]
        public void Long_RendersFullMonthDayYearAndClockTime()
        {
            var value = new DateTimeOffset(2026, 8, 22, 15, 45, 0, TimeSpan.Zero);
            Assert.Equal("August 22, 2026, 3:45 PM", MuiTimestampFormatter.Format(value, MuiTimestampFormat.Long, Now));
        }

        [Fact]
        public void TimeOnly_RendersJustTheClockTime()
        {
            var value = new DateTimeOffset(2026, 8, 22, 15, 45, 0, TimeSpan.Zero);
            Assert.Equal("3:45 PM", MuiTimestampFormatter.Format(value, MuiTimestampFormat.TimeOnly, Now));
        }

        [Fact]
        public void FormatAbsoluteTooltip_AlwaysRendersTheFullLongForm()
        {
            // timestamp.md § Accessibility: the tooltip carries the full
            // absolute date+time regardless of which format is displayed.
            var value = new DateTimeOffset(2026, 8, 22, 15, 45, 0, TimeSpan.Zero);
            Assert.Equal("August 22, 2026, 3:45 PM", MuiTimestampFormatter.FormatAbsoluteTooltip(value));
        }
    }
}
