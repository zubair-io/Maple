using System;

namespace Maple.UI.Atoms
{
    /// <summary>
    /// Plain, WinUI-free logic behind MuiQrPlaceholder — deterministically
    /// derives a block pattern from a payload string. This is NOT a real QR
    /// code: docs/unified-component-catalog.md §1.4's "QR Code" row calls
    /// for one, but no QR-capable dependency exists in Maple.WinUI.csproj
    /// (checked: CommunityToolkit.WinUI.UI.Controls 7.1.2 carries none), and
    /// this wave has no local Windows toolchain to compile-verify a newly
    /// added NuGet package's API surface against — adding one blind was
    /// judged worse than a placeholder (see the real-QR follow-up filed on
    /// #3012). This class exists so the placeholder still *looks*
    /// payload-derived — the same input always renders the same block grid,
    /// unlike static noise — and so that determinism is unit-tested the same
    /// way MuiAvatarPalette's hash is.
    /// </summary>
    public static class MuiQrPlaceholderPattern
    {
        /// <summary>Deterministic N×N fill pattern for <paramref name="payload"/>,
        /// row-major (`grid[row, col]`), true = filled cell. A tiny xorshift
        /// PRNG reseeded from an FNV-1a hash of the payload — not
        /// cryptographic, just needs to be stable and payload-sensitive.
        /// Three corner "finder" squares are stamped on top, purely for
        /// visual resemblance to a real QR code's fixed corner markers.</summary>
        public static bool[,] Generate(string payload, int gridSize)
        {
            if (gridSize <= 0)
                throw new ArgumentOutOfRangeException(nameof(gridSize));

            var state = MuiAvatarPalette.StableHash(payload ?? string.Empty);
            if (state == 0)
                state = 1; // xorshift is a fixed point at 0 — never let it stick there.

            var grid = new bool[gridSize, gridSize];
            for (var y = 0; y < gridSize; y++)
            {
                for (var x = 0; x < gridSize; x++)
                {
                    state ^= state << 13;
                    state ^= state >> 17;
                    state ^= state << 5;
                    grid[y, x] = (state & 1) == 1;
                }
            }

            StampFinderPattern(grid, 0, 0);
            StampFinderPattern(grid, 0, gridSize - 7);
            StampFinderPattern(grid, gridSize - 7, 0);
            return grid;
        }

        /// <summary>A real QR code's three corner "finder" squares are fixed,
        /// data-independent 7×7 markers (solid ring, blank gap, solid
        /// core) — stamped here purely for visual resemblance, not decoded
        /// meaning. A no-op if the grid is too small to fit one.</summary>
        private static void StampFinderPattern(bool[,] grid, int top, int left)
        {
            var size = grid.GetLength(0);
            if (top < 0 || left < 0 || top + 7 > size || left + 7 > size)
                return;

            for (var y = 0; y < 7; y++)
            {
                for (var x = 0; x < 7; x++)
                {
                    var onBorder = y == 0 || y == 6 || x == 0 || x == 6;
                    var onCore = y is >= 2 and <= 4 && x is >= 2 and <= 4;
                    grid[top + y, left + x] = onBorder || onCore;
                }
            }
        }
    }
}
