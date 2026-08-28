// MuiQrMatrixTests — the payload→module-matrix seam behind the Maple.UI
// QR Code atom (Maple.WinUI/MapleUI/Atoms/MuiQrMatrix.cs, MN4 #3053, over
// the QRCoder package). No WinUI/live Window involved. These pin the
// structural QR invariants the renderer and any scanner rely on; the
// end-to-end "actually scans" proof is the on-device evidence in the PR.

using Maple.UI.Atoms;
using Xunit;

namespace Maple.WinUI.Tests
{
    public class MuiQrMatrixTests
    {
        [Fact]
        public void Encode_ShortPayload_IsVersion1Matrix()
        {
            // ≤13 bytes fits QR version 1 at ECC Q → 21×21 — which also
            // proves the quiet zone QRCoder bakes into its raw matrix
            // (4 modules per side) was stripped.
            var grid = MuiQrMatrix.Encode("maple");
            Assert.Equal(21, grid.GetLength(0));
            Assert.Equal(21, grid.GetLength(1));
        }

        [Fact]
        public void Encode_IsDeterministic()
        {
            var first = MuiQrMatrix.Encode("maple-app://pair/abc123");
            var second = MuiQrMatrix.Encode("maple-app://pair/abc123");
            Assert.Equal(first, second);
        }

        [Fact]
        public void Encode_LongerPayload_GrowsTheMatrix()
        {
            var small = MuiQrMatrix.Encode("short");
            var large = MuiQrMatrix.Encode(new string('x', 220));
            Assert.True(large.GetLength(0) > small.GetLength(0));
            // Versions step by 4 modules and stay odd-sized.
            Assert.Equal(1, large.GetLength(0) % 2);
            Assert.Equal(0, (large.GetLength(0) - 21) % 4);
        }

        [Fact]
        public void Encode_StampsRealFinderPatterns()
        {
            // A finder pattern is a dark 7×7 ring, a light inner ring, and
            // a dark 3×3 core — the fixed structure every scanner locks
            // onto, in three corners at size-relative offsets. Spot-check
            // each ring's characteristic cells in all three.
            var grid = MuiQrMatrix.Encode("maple-pair:AB12-CD34");
            var far = grid.GetLength(0) - 7;
            foreach (var (top, left) in new[] { (0, 0), (0, far), (far, 0) })
            {
                Assert.True(grid[top, left]);             // outer ring corner
                Assert.True(grid[top + 6, left + 6]);     // outer ring corner
                Assert.False(grid[top + 1, left + 1]);    // light separator ring
                Assert.True(grid[top + 3, left + 3]);     // dark core centre
            }
        }

        [Fact]
        public void Encode_EmptyPayload_StillProducesAMatrix()
        {
            // Empty text is substituted with a single space (QR has no
            // zero-length payload) — the atom must never throw at its
            // default state.
            var grid = MuiQrMatrix.Encode("");
            Assert.True(grid.GetLength(0) >= 21);
        }
    }
}
