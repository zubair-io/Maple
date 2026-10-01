using Maple.WinUI.Services.Metadata;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class JpegDimensionsTests
{
    [Theory]
    [InlineData(0xC0)]
    [InlineData(0xC2)]
    [InlineData(0xC3)]
    [InlineData(0xC9)]
    public void FrameWithoutExifProvidesDimensions(int marker)
    {
        var bytes = Frame((byte)marker);
        var metadata = Read(bytes);
        Assert.NotNull(metadata);
        Assert.Equal(640, metadata.PixelWidth);
        Assert.Equal(480, metadata.PixelHeight);
        Assert.Null(metadata.CameraModel);
    }

    [Theory]
    [InlineData(0xC4)]
    [InlineData(0xC8)]
    [InlineData(0xCC)]
    public void OtherMarkersAreNotFrameDimensions(int marker) => Assert.Null(Read(Frame((byte)marker)));

    [Fact]
    public void FrameDimensionsRetainExifOrientation()
    {
        // One little-endian TIFF IFD entry: Orientation = 6.
        byte[] tiff = { 0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0,
            0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0 };
        byte[] app1 = { 0xFF, 0xD8, 0xFF, 0xE1, 0, 34, 69, 120, 105, 102, 0, 0 };
        var metadata = Read(app1.Concat(tiff).Concat(Frame(0xC2)[2..]).ToArray());
        Assert.NotNull(metadata);
        Assert.Equal(6, metadata.Orientation);
        Assert.Equal(640, metadata.PixelWidth);
        Assert.Equal(480, metadata.PixelHeight);
    }

    [Fact]
    public void MalformedExifDoesNotHideValidFrameDimensions()
    {
        byte[] badExif = { 0xFF, 0xD8, 0xFF, 0xE1, 0, 16,
            69, 120, 105, 102, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 };
        var metadata = Read(badExif.Concat(Frame(0xC0)[2..]).ToArray());
        Assert.NotNull(metadata);
        Assert.Equal(640, metadata.PixelWidth);
        Assert.Equal(480, metadata.PixelHeight);
    }

    [Fact]
    public void RejectsTruncatedFrameAndDoesNotScanEntropyData()
    {
        Assert.Null(Read(Frame(0xC2)[..12]));
        Assert.Null(Read(new byte[] { 0xFF, 0xD8, 0xFF, 0xDA, 0, 2 }.Concat(Frame(0xC2)[2..]).ToArray()));
        var zeroWidth = Frame(0xC2);
        zeroWidth[9] = zeroWidth[10] = 0;
        Assert.Null(Read(zeroWidth));
    }

    private static byte[] Frame(byte marker) => new byte[]
    {
        0xFF, 0xD8, 0xFF, marker, 0, 11, 8, 1, 0xE0, 2, 0x80, 1, 1, 0x11, 0, 0xFF, 0xD9,
    };

    private static ExifData? Read(byte[] bytes)
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".jpg");
        try
        {
            File.WriteAllBytes(path, bytes);
            return ExifReader.Read(path);
        }
        finally { File.Delete(path); }
    }
}
