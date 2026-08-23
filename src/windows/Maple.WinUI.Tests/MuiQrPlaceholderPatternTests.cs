// MuiQrPlaceholderPatternTests — the deterministic block-pattern generator
// behind MuiQrPlaceholder (Maple.WinUI/MapleUI/Atoms/MuiQrPlaceholderPattern.cs,
// wave 2 of the Windows Maple.UI atoms, #3012). This is NOT a real QR
// encoder (see that file's header comment for why — no QR-capable
// dependency exists yet, tracked as a follow-up on #3012); these tests only
// cover the placeholder's determinism and finder-square stamping, which is
// the one part of that atom CI can actually verify without a live Window.

using Maple.UI.Atoms;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiQrPlaceholderPatternTests
    {
        [Fact]
        public void Generate_SamePayloadTwice_ProducesTheIdenticalPattern()
        {
            var first = MuiQrPlaceholderPattern.Generate("maple-app://pair/abc123", 21);
            var second = MuiQrPlaceholderPattern.Generate("maple-app://pair/abc123", 21);

            for (var y = 0; y < 21; y++)
                for (var x = 0; x < 21; x++)
                    Assert.Equal(first[y, x], second[y, x]);
        }

        [Fact]
        public void Generate_DifferentPayloads_ProduceDifferentPatterns()
        {
            var a = MuiQrPlaceholderPattern.Generate("payload-a", 21);
            var b = MuiQrPlaceholderPattern.Generate("payload-b", 21);

            var anyDifferent = false;
            for (var y = 0; y < 21 && !anyDifferent; y++)
                for (var x = 0; x < 21 && !anyDifferent; x++)
                    if (a[y, x] != b[y, x])
                        anyDifferent = true;

            Assert.True(anyDifferent, "Two distinct payloads produced an identical pattern.");
        }

        [Fact]
        public void Generate_ReturnsARequestedSizeSquareGrid()
        {
            var grid = MuiQrPlaceholderPattern.Generate("anything", 21);
            Assert.Equal(21, grid.GetLength(0));
            Assert.Equal(21, grid.GetLength(1));
        }

        [Fact]
        public void Generate_EmptyPayload_StillProducesADeterministicPattern()
        {
            var first = MuiQrPlaceholderPattern.Generate("", 21);
            var second = MuiQrPlaceholderPattern.Generate("", 21);

            for (var y = 0; y < 21; y++)
                for (var x = 0; x < 21; x++)
                    Assert.Equal(first[y, x], second[y, x]);
        }

        [Fact]
        public void Generate_StampsAllThreeFinderSquareCorners()
        {
            // The three fixed 7x7 finder markers (top-left, top-right,
            // bottom-left) are stamped on top of the hashed noise — every
            // corner's own top-left cell (the ring's corner) must always be
            // filled regardless of payload, since it's part of the border.
            var grid = MuiQrPlaceholderPattern.Generate("any-payload", 21);

            Assert.True(grid[0, 0]);       // top-left finder, corner
            Assert.True(grid[0, 14]);      // top-right finder, corner (21-7=14)
            Assert.True(grid[14, 0]);      // bottom-left finder, corner

            // Each finder's ring has a blank gap one cell in from the border.
            Assert.False(grid[1, 1]);
            Assert.False(grid[1, 15]);
            Assert.False(grid[15, 1]);

            // Each finder's solid 3x3 core.
            Assert.True(grid[3, 3]);
            Assert.True(grid[3, 17]);
            Assert.True(grid[17, 3]);
        }
    }
}
