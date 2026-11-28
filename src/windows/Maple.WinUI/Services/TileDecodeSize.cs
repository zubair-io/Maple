using System;
using System.Buffers.Binary;
using System.IO;

namespace Maple.WinUI.Services;

internal readonly record struct TileDecode(int? PixelWidth, int? PixelHeight);

internal static class TileDecodeSize
{
    internal static int ShortEdgePixels(double cellDip, double rasterizationScale) =>
        (int)Math.Min(Math.Ceiling(cellDip * rasterizationScale), int.MaxValue);

    internal static TileDecode For(int sourceWidth, int sourceHeight, double cellDip, double rasterizationScale)
    {
        if (!IsPositiveFinite(cellDip) || !IsPositiveFinite(rasterizationScale)) return default;
        var shortEdge = Math.Min(sourceWidth, sourceHeight);
        var target = ShortEdgePixels(cellDip, rasterizationScale);
        return shortEdge <= 0 || target >= shortEdge ? default
            : sourceWidth <= sourceHeight ? new TileDecode(target, null)
            : new TileDecode(null, target);
    }

    private static bool IsPositiveFinite(double value) => double.IsFinite(value) && value > 0;

    internal static TileDecode ForFile(string path, double cellDip, double rasterizationScale) =>
        PngHeader.TryReadSize(path) is var (width, height)
            ? For(width, height, cellDip, rasterizationScale)
            : default;
}

internal static class PngHeader
{
    private static readonly byte[] Signature = { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };
    private const int HeaderLength = 24;

    internal static (int Width, int Height)? TryReadSize(string path)
    {
        try
        {
            Span<byte> header = stackalloc byte[HeaderLength];
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1);
            if (stream.ReadAtLeast(header, HeaderLength, throwOnEndOfStream: false) < HeaderLength) return null;
            if (!header[..Signature.Length].SequenceEqual(Signature) || !header.Slice(12, 4).SequenceEqual("IHDR"u8)) return null;
            var width = BinaryPrimitives.ReadInt32BigEndian(header.Slice(16, 4));
            var height = BinaryPrimitives.ReadInt32BigEndian(header.Slice(20, 4));
            return width > 0 && height > 0 ? (width, height) : null;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
