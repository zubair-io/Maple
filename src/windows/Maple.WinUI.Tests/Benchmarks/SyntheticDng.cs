using System.Buffers.Binary;

namespace Maple.WinUI.Tests;

internal static class SyntheticDng
{
    private const ushort ImageWidth = 256;
    private const ushort ImageLength = 257;
    private const ushort RowsPerStrip = 278;
    private const ushort StripByteCounts = 279;
    private const int StripOffset = 518;
    private const int EntrySize = 12;

    internal static string Write(string path, int width, int height)
    {
        var template = File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "Fixtures", "grey-l018-rggb.dng"));
        var header = template[..StripOffset];
        SetLong(header, ImageWidth, (uint)width);
        SetLong(header, ImageLength, (uint)height);
        SetLong(header, RowsPerStrip, (uint)height);
        SetLong(header, StripByteCounts, checked((uint)(width * height * 2)));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using var stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20);
        stream.Write(header);
        var row = new byte[width * 2];
        var random = new Random(20260526);
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                var channel = (y & 1) * 2 + (x & 1);
                var scene = 4000 + (x * 20000L / width) + (y * 12000L / height) + channel * 900;
                var noise = random.Next(0, 600);
                BinaryPrimitives.WriteUInt16LittleEndian(row.AsSpan(x * 2), (ushort)(scene + noise));
            }
            stream.Write(row);
        }
        return path;
    }

    private static void SetLong(byte[] header, ushort tag, uint value)
    {
        var count = BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(8));
        for (var index = 0; index < count; index++)
        {
            var entry = 10 + index * EntrySize;
            if (BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(entry)) != tag) continue;
            BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(entry + 2), 4);
            BinaryPrimitives.WriteUInt32LittleEndian(header.AsSpan(entry + 8), value);
            return;
        }
        throw new InvalidDataException($"The template DNG has no tag {tag}.");
    }
}
