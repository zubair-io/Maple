using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace Maple.WinUI.Services.Metadata;

/// <summary>
/// Capture metadata extracted from an image file. Any field the file does not
/// carry (or that could not be parsed safely) is null.
/// </summary>
public sealed record ExifData(
    string? CameraMake,
    string? CameraModel,
    string? LensModel,
    int? Iso,
    double? FNumber,
    double? ExposureTimeSeconds,
    double? FocalLengthMm,
    DateTime? DateTimeOriginal,
    int? Orientation,
    int? PixelWidth,
    int? PixelHeight);

/// <summary>
/// Self-contained EXIF reader for TIFF-container RAW files (DNG, CR2, NEF, ARW,
/// ORF, RW2, PEF) and plain JPEG/TIFF. Reads via bounded seeks — never loads the
/// whole file. Malformed input yields null or partial data, never an exception.
/// </summary>
public static class ExifReader
{
    // Tag ids (TIFF/EXIF standard).
    private const ushort TagImageWidth = 0x0100;
    private const ushort TagImageLength = 0x0101;
    private const ushort TagMake = 0x010F;
    private const ushort TagModel = 0x0110;
    private const ushort TagOrientation = 0x0112;
    private const ushort TagSubIfds = 0x014A;
    private const ushort TagExposureTime = 0x829A;
    private const ushort TagFNumber = 0x829D;
    private const ushort TagExifIfdPointer = 0x8769;
    private const ushort TagIso = 0x8827;
    private const ushort TagRecommendedExposureIndex = 0x8832;
    private const ushort TagDateTimeOriginal = 0x9003;
    private const ushort TagFocalLength = 0x920A;
    private const ushort TagExifPixelXDimension = 0xA002;
    private const ushort TagExifPixelYDimension = 0xA003;
    private const ushort TagLensModel = 0xA434;

    // Safety caps against malformed files.
    private const int MaxIfdEntries = 1024;
    private const int MaxValueBytes = 64 * 1024;
    private const int MaxIfdsVisited = 32;
    private const int MaxSubIfdPointers = 8;
    private const int MaxJpegSegments = 64;

    /// <summary>
    /// Reads EXIF metadata from <paramref name="filePath"/>. Returns null when the
    /// file is missing, unreadable, not a recognized container, or carries no
    /// extractable metadata.
    /// </summary>
    public static ExifData? Read(string filePath)
    {
        try
        {
            return ReadCore(filePath);
        }
        catch
        {
            // Contract: never throw out of Read(). I/O races, permission changes,
            // and pathological containers all degrade to "no metadata".
            return null;
        }
    }

    private static ExifData? ReadCore(string filePath)
    {
        if (string.IsNullOrWhiteSpace(filePath) || !File.Exists(filePath)) return null;

        using var stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length < 8) return null;

        var head = ReadExact(stream, 0, 2);
        if (head is null) return null;

        return head[0] == 0xFF && head[1] == 0xD8
            ? ReadJpeg(stream)
            : ReadTiff(stream, baseOffset: 0, length: stream.Length);
    }

    // ---------------------------------------------------------------- JPEG ----

    /// <summary>Scans JPEG segments for the APP1 "Exif" payload and parses the embedded TIFF.</summary>
    private static ExifData? ReadJpeg(FileStream stream)
    {
        long pos = 2;
        for (var i = 0; i < MaxJpegSegments && pos + 4 <= stream.Length; i++)
        {
            var hdr = ReadExact(stream, pos, 4);
            if (hdr is null || hdr[0] != 0xFF) return null;

            var marker = hdr[1];
            if (marker == 0xFF) { pos += 1; continue; }                 // fill byte
            if (marker == 0x01 || (marker >= 0xD0 && marker <= 0xD8)) { pos += 2; continue; } // no payload
            if (marker == 0xD9 || marker == 0xDA) return null;          // EOI / SOS: no Exif ahead

            var segLen = (hdr[2] << 8) | hdr[3];                        // includes the 2 length bytes
            if (segLen < 2 || pos + 2 + segLen > stream.Length) return null;

            if (marker == 0xE1 && segLen >= 2 + 6 + 8)
            {
                var sig = ReadExact(stream, pos + 4, 6);
                var isExif = sig is not null
                    && sig[0] == (byte)'E' && sig[1] == (byte)'x' && sig[2] == (byte)'i'
                    && sig[3] == (byte)'f' && sig[4] == 0 && sig[5] == 0;
                if (isExif)
                {
                    var tiffBase = pos + 4 + 6;
                    var tiffLen = segLen - 2 - 6;
                    return ReadTiff(stream, tiffBase, tiffLen);
                }
            }
            pos += 2 + segLen;
        }
        return null;
    }

    // ---------------------------------------------------------------- TIFF ----

    private static ExifData? ReadTiff(FileStream stream, long baseOffset, long length)
    {
        var tiff = TiffReader.Open(stream, baseOffset, length);
        if (tiff is null) return null;

        var acc = new Accumulator();
        var visited = new HashSet<uint>();

        // Walk the IFD0 chain (CR2 keeps its full-res sensor IFD at the chain tail).
        var next = tiff.FirstIfdOffset;
        while (next != 0 && visited.Count < MaxIfdsVisited && visited.Add(next))
        {
            var chained = ParseIfd(tiff, next, acc);
            if (chained is null) break;
            next = chained.Value;
        }

        // EXIF sub-IFD (capture settings).
        if (acc.ExifIfdOffset is { } exifOffset && visited.Count < MaxIfdsVisited && visited.Add(exifOffset))
        {
            ParseIfd(tiff, exifOffset, acc);
        }

        // SubIFDs (tag 0x014A) — DNG/NEF/PEF keep the real image dimensions here.
        foreach (var sub in acc.SubIfdOffsets)
        {
            if (visited.Count >= MaxIfdsVisited || !visited.Add(sub)) continue;
            ParseIfd(tiff, sub, acc);
        }

        return acc.ToResult();
    }

    /// <summary>Parses one IFD, feeding recognized tags into <paramref name="acc"/>. Returns the next-IFD offset, or null on structural failure.</summary>
    private static uint? ParseIfd(TiffReader tiff, uint ifdOffset, Accumulator acc)
    {
        var countBytes = tiff.Bytes(ifdOffset, 2);
        if (countBytes is null) return null;

        int entryCount = tiff.U16(countBytes, 0);
        if (entryCount == 0 || entryCount > MaxIfdEntries) return null;

        var entries = tiff.Bytes(ifdOffset + 2, entryCount * 12);
        if (entries is null) return null;

        int? ifdWidth = null, ifdHeight = null;

        for (var i = 0; i < entryCount; i++)
        {
            var e = i * 12;
            var tag = tiff.U16(entries, e);
            var type = tiff.U16(entries, e + 2);
            var count = tiff.U32(entries, e + 4);

            switch (tag)
            {
                case TagImageWidth:
                case TagExifPixelXDimension:
                    ifdWidth = AsInt(ReadUnsigned(tiff, entries, e, type, count)) ?? ifdWidth;
                    break;
                case TagImageLength:
                case TagExifPixelYDimension:
                    ifdHeight = AsInt(ReadUnsigned(tiff, entries, e, type, count)) ?? ifdHeight;
                    break;
                case TagMake:
                    acc.Make ??= ReadAscii(tiff, entries, e, type, count);
                    break;
                case TagModel:
                    acc.Model ??= ReadAscii(tiff, entries, e, type, count);
                    break;
                case TagLensModel:
                    acc.Lens ??= ReadAscii(tiff, entries, e, type, count);
                    break;
                case TagOrientation:
                    acc.Orientation ??= AsInt(ReadUnsigned(tiff, entries, e, type, count));
                    break;
                case TagIso:
                    // 0xFFFF is the SHORT sentinel for "see RecommendedExposureIndex".
                    var iso = AsInt(ReadUnsigned(tiff, entries, e, type, count));
                    acc.Iso ??= iso is > 0 and < 0xFFFF ? iso : null;
                    break;
                case TagRecommendedExposureIndex:
                    acc.RecommendedExposureIndex ??= AsInt(ReadUnsigned(tiff, entries, e, type, count));
                    break;
                case TagFNumber:
                    acc.FNumber ??= ReadRational(tiff, entries, e, type, count);
                    break;
                case TagExposureTime:
                    acc.ExposureTime ??= ReadRational(tiff, entries, e, type, count);
                    break;
                case TagFocalLength:
                    acc.FocalLength ??= ReadRational(tiff, entries, e, type, count);
                    break;
                case TagDateTimeOriginal:
                    acc.DateTimeOriginal ??= ParseExifDateTime(ReadAscii(tiff, entries, e, type, count));
                    break;
                case TagExifIfdPointer:
                    acc.ExifIfdOffset ??= ReadUnsigned(tiff, entries, e, type, count);
                    break;
                case TagSubIfds:
                    CollectSubIfds(tiff, entries, e, type, count, acc);
                    break;
            }
        }

        if (ifdWidth is { } w && ifdHeight is { } h) acc.ConsiderDimensions(w, h);

        var nextBytes = tiff.Bytes(ifdOffset + 2 + (long)entryCount * 12, 4);
        return nextBytes is null ? 0u : tiff.U32(nextBytes, 0);
    }

    // -------------------------------------------------------- value decoding ----

    private static int TypeSize(ushort type) => type switch
    {
        1 or 2 or 6 or 7 => 1,  // BYTE, ASCII, SBYTE, UNDEFINED
        3 or 8 => 2,            // SHORT, SSHORT
        4 or 9 or 11 => 4,      // LONG, SLONG, FLOAT
        5 or 10 or 12 => 8,     // RATIONAL, SRATIONAL, DOUBLE
        _ => 0,
    };

    /// <summary>Fetches an entry's raw value bytes, honoring the inline-when-≤4-bytes rule.</summary>
    private static byte[]? ValueBytes(TiffReader tiff, byte[] entries, int entryOffset, ushort type, uint count)
    {
        var elemSize = TypeSize(type);
        if (elemSize == 0 || count == 0 || count > (uint)(MaxValueBytes / elemSize)) return null;

        var total = (int)count * elemSize;
        if (total <= 4)
        {
            var inline = new byte[total];
            Array.Copy(entries, entryOffset + 8, inline, 0, total);
            return inline;
        }
        return tiff.Bytes(tiff.U32(entries, entryOffset + 8), total);
    }

    /// <summary>Reads the first element of a BYTE/SHORT/LONG value.</summary>
    private static uint? ReadUnsigned(TiffReader tiff, byte[] entries, int entryOffset, ushort type, uint count)
    {
        var v = ValueBytes(tiff, entries, entryOffset, type, count);
        if (v is null) return null;
        return type switch
        {
            1 => v[0],
            3 => tiff.U16(v, 0),
            4 => tiff.U32(v, 0),
            _ => null,
        };
    }

    /// <summary>Reads the first element of a RATIONAL/SRATIONAL value as a double.</summary>
    private static double? ReadRational(TiffReader tiff, byte[] entries, int entryOffset, ushort type, uint count)
    {
        if (type != 5 && type != 10) return null;
        var v = ValueBytes(tiff, entries, entryOffset, type, count);
        if (v is null || v.Length < 8) return null;

        if (type == 5)
        {
            var num = tiff.U32(v, 0);
            var den = tiff.U32(v, 4);
            return den == 0 ? null : (double)num / den;
        }
        var snum = (int)tiff.U32(v, 0);
        var sden = (int)tiff.U32(v, 4);
        return sden == 0 ? null : (double)snum / sden;
    }

    private static string? ReadAscii(TiffReader tiff, byte[] entries, int entryOffset, ushort type, uint count)
    {
        if (type != 2 && type != 7) return null; // some writers mislabel strings as UNDEFINED
        var v = ValueBytes(tiff, entries, entryOffset, type, count);
        if (v is null) return null;

        var terminator = Array.IndexOf(v, (byte)0);
        var textLength = terminator >= 0 ? terminator : v.Length;
        var text = Encoding.ASCII.GetString(v, 0, textLength).Trim();
        return text.Length > 0 ? text : null;
    }

    private static void CollectSubIfds(TiffReader tiff, byte[] entries, int entryOffset, ushort type, uint count, Accumulator acc)
    {
        if (type != 4) return;
        var pointerCount = Math.Min(count, (uint)MaxSubIfdPointers);
        var v = ValueBytes(tiff, entries, entryOffset, type, count);
        if (v is null) return;
        for (var i = 0; i < pointerCount; i++)
        {
            var offset = tiff.U32(v, i * 4);
            if (offset != 0) acc.SubIfdOffsets.Add(offset);
        }
    }

    private static DateTime? ParseExifDateTime(string? text)
    {
        if (text is null) return null;
        var ok = DateTime.TryParseExact(
            text, "yyyy:MM:dd HH:mm:ss", CultureInfo.InvariantCulture,
            DateTimeStyles.None, out var parsed);
        return ok ? parsed : null;
    }

    private static int? AsInt(uint? value) => value is { } v && v <= int.MaxValue ? (int)v : null;

    private static byte[]? ReadExact(FileStream stream, long offset, int count)
    {
        if (offset < 0 || count <= 0 || offset + count > stream.Length) return null;
        stream.Seek(offset, SeekOrigin.Begin);
        var buffer = new byte[count];
        var read = 0;
        while (read < count)
        {
            var n = stream.Read(buffer, read, count - read);
            if (n <= 0) return null;
            read += n;
        }
        return buffer;
    }

    // ------------------------------------------------------------- helpers ----

    /// <summary>Mutable collector for tag values found while walking IFDs. First value wins for scalars; largest area wins for dimensions.</summary>
    private sealed class Accumulator
    {
        public string? Make;
        public string? Model;
        public string? Lens;
        public int? Iso;
        public int? RecommendedExposureIndex;
        public double? FNumber;
        public double? ExposureTime;
        public double? FocalLength;
        public DateTime? DateTimeOriginal;
        public int? Orientation;
        public uint? ExifIfdOffset;
        public readonly List<uint> SubIfdOffsets = new();

        private int? _width;
        private int? _height;

        public void ConsiderDimensions(int width, int height)
        {
            if (width <= 0 || height <= 0) return;
            var currentArea = (long)(_width ?? 0) * (_height ?? 0);
            if ((long)width * height <= currentArea) return;
            _width = width;
            _height = height;
        }

        public ExifData? ToResult()
        {
            var iso = Iso ?? (RecommendedExposureIndex is > 0 ? RecommendedExposureIndex : null);
            var result = new ExifData(
                Make, Model, Lens, iso, FNumber, ExposureTime, FocalLength,
                DateTimeOriginal, Orientation, _width, _height);
            return result == new ExifData(null, null, null, null, null, null, null, null, null, null, null)
                ? null
                : result;
        }
    }

    /// <summary>
    /// Bounded window over a TIFF structure inside a stream. All offsets are relative
    /// to the TIFF header; every read is validated against the window before seeking.
    /// </summary>
    private sealed class TiffReader
    {
        private readonly FileStream _stream;
        private readonly long _baseOffset;
        private readonly long _length;
        private readonly bool _bigEndian;

        public uint FirstIfdOffset { get; }

        private TiffReader(FileStream stream, long baseOffset, long length, bool bigEndian, uint firstIfd)
        {
            _stream = stream;
            _baseOffset = baseOffset;
            _length = length;
            _bigEndian = bigEndian;
            FirstIfdOffset = firstIfd;
        }

        /// <summary>Validates the TIFF header (including ORF/RW2 magic variants) and returns a reader, or null.</summary>
        public static TiffReader? Open(FileStream stream, long baseOffset, long length)
        {
            var boundedLength = Math.Min(length, stream.Length - baseOffset);
            if (baseOffset < 0 || boundedLength < 8) return null;

            var probe = new TiffReader(stream, baseOffset, boundedLength, bigEndian: false, firstIfd: 0);
            var header = probe.Bytes(0, 8);
            if (header is null) return null;

            bool bigEndian;
            if (header[0] == 0x49 && header[1] == 0x49) bigEndian = false;      // "II"
            else if (header[0] == 0x4D && header[1] == 0x4D) bigEndian = true;  // "MM"
            else return null;

            var sized = new TiffReader(stream, baseOffset, boundedLength, bigEndian, firstIfd: 0);
            var magic = sized.U16(header, 2);
            // 42: TIFF/DNG/CR2/NEF/ARW/PEF.  0x4F52 "RO" / 0x5352 "SR": Olympus ORF.
            // 0x0055 "U\0": Panasonic RW2 (header otherwise TIFF-shaped; standard tags best-effort).
            var recognized = magic is 42 or 0x4F52 or 0x5352 or 0x0055;
            if (!recognized) return null;

            var firstIfd = sized.U32(header, 4);
            return firstIfd == 0 || firstIfd >= boundedLength
                ? null
                : new TiffReader(stream, baseOffset, boundedLength, bigEndian, firstIfd);
        }

        /// <summary>Reads <paramref name="count"/> bytes at TIFF-relative <paramref name="offset"/>, or null if out of bounds.</summary>
        public byte[]? Bytes(long offset, int count)
        {
            if (offset < 0 || count <= 0 || offset + count > _length) return null;
            return ReadExact(_stream, _baseOffset + offset, count);
        }

        public ushort U16(byte[] b, int i) => _bigEndian
            ? (ushort)((b[i] << 8) | b[i + 1])
            : (ushort)((b[i + 1] << 8) | b[i]);

        public uint U32(byte[] b, int i) => _bigEndian
            ? ((uint)b[i] << 24) | ((uint)b[i + 1] << 16) | ((uint)b[i + 2] << 8) | b[i + 3]
            : ((uint)b[i + 3] << 24) | ((uint)b[i + 2] << 16) | ((uint)b[i + 1] << 8) | b[i];
    }
}
