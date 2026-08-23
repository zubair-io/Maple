// MediaTransportStateTests — the pure play/pause/scrub/mm:ss transport
// state machine shared by the Maple.UI Video Player and Audio Player
// molecules (Maple.WinUI/MapleUI/Molecules/MediaTransportState.cs, wave
// N3b of the Windows Maple.UI molecules, #3012). No WinUI/live Window
// involved.

using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MediaTransportMathTests
    {
        [Theory]
        [InlineData(0, "0:00")]
        [InlineData(5, "0:05")]
        [InlineData(65, "1:05")]
        [InlineData(59.9, "0:59")] // floors, never rounds up into 1:00
        [InlineData(125, "2:05")]
        public void FormatDuration_FormatsAsMinutesSeconds(double seconds, string expected)
        {
            Assert.Equal(expected, MediaTransportMath.FormatDuration(seconds));
        }

        [Theory]
        [InlineData(-1)]
        [InlineData(double.NaN)]
        [InlineData(double.PositiveInfinity)]
        [InlineData(double.NegativeInfinity)]
        public void FormatDuration_NonFiniteOrNegative_ReadsAsZero(double seconds)
        {
            Assert.Equal("0:00", MediaTransportMath.FormatDuration(seconds));
        }

        [Fact]
        public void ComputeProgressPercent_HalfwayThrough_IsFifty()
        {
            Assert.Equal(50, MediaTransportMath.ComputeProgressPercent(30, 60));
        }

        [Fact]
        public void ComputeProgressPercent_ZeroDuration_IsZero()
        {
            Assert.Equal(0, MediaTransportMath.ComputeProgressPercent(0, 0));
        }

        [Fact]
        public void ComputeProgressPercent_AtEnd_IsOneHundred()
        {
            Assert.Equal(100, MediaTransportMath.ComputeProgressPercent(60, 60));
        }
    }

    public class MediaTransportStateTests
    {
        [Fact]
        public void InitialState_IsPausedAtZero()
        {
            var state = new MediaTransportState();
            Assert.False(state.IsPlaying);
            Assert.Equal(0, state.CurrentTimeSeconds);
            Assert.Equal(0, state.DurationSeconds);
            Assert.Equal("0:00", state.FormattedCurrentTime);
        }

        [Fact]
        public void TogglePlay_FlipsIsPlaying()
        {
            var state = new MediaTransportState();
            state.TogglePlay();
            Assert.True(state.IsPlaying);
            state.TogglePlay();
            Assert.False(state.IsPlaying);
        }

        [Fact]
        public void SetPosition_ClampsIntoZeroToDuration()
        {
            var state = new MediaTransportState();
            state.SetDuration(120);

            state.SetPosition(200);
            Assert.Equal(120, state.CurrentTimeSeconds);

            state.SetPosition(-10);
            Assert.Equal(0, state.CurrentTimeSeconds);
        }

        [Fact]
        public void SetDuration_NegativeValue_ClampsToZero()
        {
            var state = new MediaTransportState();
            state.SetDuration(-5);
            Assert.Equal(0, state.DurationSeconds);
        }

        [Fact]
        public void SetDuration_ShrinkingBelowCurrentPosition_PullsPositionBackToo()
        {
            var state = new MediaTransportState();
            state.SetDuration(100);
            state.SetPosition(50);

            state.SetDuration(30);

            Assert.Equal(30, state.CurrentTimeSeconds);
        }

        [Fact]
        public void SeekToRatio_ScalesByDuration()
        {
            var state = new MediaTransportState();
            state.SetDuration(120);
            state.SeekToRatio(0.5);
            Assert.Equal(60, state.CurrentTimeSeconds);
        }

        [Fact]
        public void SeekToRatio_ClampsRatioOutsideZeroToOne()
        {
            var state = new MediaTransportState();
            state.SetDuration(120);
            state.SeekToRatio(1.5);
            Assert.Equal(120, state.CurrentTimeSeconds);
        }

        [Fact]
        public void SeekToRatio_NoDurationYet_IsNoOp()
        {
            var state = new MediaTransportState();
            state.SeekToRatio(0.5);
            Assert.Equal(0, state.CurrentTimeSeconds);
        }

        [Fact]
        public void ProgressPercentAndFormattedTimes_ReflectLiveState()
        {
            var state = new MediaTransportState();
            state.SetDuration(90);
            state.SetPosition(45);

            Assert.Equal(50, state.ProgressPercent);
            Assert.Equal("0:45", state.FormattedCurrentTime);
            Assert.Equal("1:30", state.FormattedDuration);
        }

        [Fact]
        public void Changed_FiresOnStateTransition_NotOnNoOpSet()
        {
            var state = new MediaTransportState();
            var raiseCount = 0;
            state.Changed += (_, _) => raiseCount++;

            state.SetPlaying(true);
            Assert.Equal(1, raiseCount);

            state.SetPlaying(true); // already true — no-op
            Assert.Equal(1, raiseCount);

            state.SetPlaying(false);
            Assert.Equal(2, raiseCount);
        }
    }
}
