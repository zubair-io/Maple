using System;
using QRCoder;

namespace Maple.UI.Atoms
{
    /// <summary>
    /// The payload→module-matrix step behind <see cref="MuiQrCode"/> (MN4,
    /// #3053) — the one place the QRCoder dependency is touched, WinUI-free
    /// and linked into Maple.WinUI.Tests so the encoding contract (square
    /// odd-sized matrix, corner finder patterns, determinism, version growth)
    /// is verified without a live Window. ECC level Q (~25% recovery) — the
    /// usual choice for codes scanned off a screen.
    /// </summary>
    public static class MuiQrMatrix
    {
        /// <summary>Dark-module matrix for <paramref name="payload"/>,
        /// row-major (`grid[row, col]`), true = dark, WITHOUT the quiet
        /// zone (QRCoder's raw matrix carries a 4-module quiet border on
        /// every side; the rendering atom draws its own scaled quiet zone,
        /// so it is stripped here).</summary>
        public static bool[,] Encode(string payload)
        {
            using var generator = new QRCodeGenerator();
            using var data = generator.CreateQrCode(
                string.IsNullOrEmpty(payload) ? " " : payload, QRCodeGenerator.ECCLevel.Q);

            const int quiet = 4;
            var modules = data.ModuleMatrix;
            var count = modules.Count - quiet * 2;
            if (count <= 0)
                throw new InvalidOperationException(
                    $"QRCoder returned a {modules.Count}-module matrix — smaller than its own quiet zone.");

            var grid = new bool[count, count];
            for (var y = 0; y < count; y++)
            {
                for (var x = 0; x < count; x++)
                    grid[y, x] = modules[y + quiet][x + quiet];
            }
            return grid;
        }
    }
}
