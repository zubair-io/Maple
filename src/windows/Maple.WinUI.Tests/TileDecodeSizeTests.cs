using System;
using System.Buffers.Binary;
using System.IO;
using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class TileDecodeSizeTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "maple-tile-decode-" + Guid.NewGuid().ToString("N"));

    public TileDecodeSizeTests() => Directory.CreateDirectory(_directory);

    public void Dispose() => Directory.Delete(_directory, recursive: true);

    [Theory]
    [InlineData(192, 1.0, 192)]
    [InlineData(192, 1.5, 288)]
    [InlineData(192, 2.0, 384)]
    [InlineData(140, 1.5, 210)]
    [InlineData(252, 1.25, 315)]
    [InlineData(141, 1.25, 177)]
    public void ShortEdgeCoversTheCellAtTheDisplayScale(double cellDip, double scale, int expected) =>
        Assert.Equal(expected, TileDecodeSize.ShortEdgePixels(cellDip, scale));

    [Fact]
    public void LandscapeTilesLimitTheHeightSoTheShortEdgeStaysFullSize()
    {
        var decode = TileDecodeSize.For(512, 341, 192, 1.0);
        Assert.Null(decode.PixelWidth);
        Assert.Equal(192, decode.PixelHeight);
    }

    [Fact]
    public void PortraitAndSquareTilesLimitTheWidth()
    {
        Assert.Equal(new TileDecode(192, null), TileDecodeSize.For(341, 512, 192, 1.0));
        Assert.Equal(new TileDecode(192, null), TileDecodeSize.For(512, 512, 192, 1.0));
    }

    [Theory]
    [InlineData(1.0, 192)]
    [InlineData(1.5, 288)]
    [InlineData(2.0, 384)]
    public void ScaleRaisesTheDecodeSoHighDpiTilesStaySharp(double scale, int expectedShortEdge) =>
        Assert.Equal(new TileDecode(expectedShortEdge, null), TileDecodeSize.For(400, 512, 192, scale));

    [Theory]
    [InlineData(512, 341, 192, 1.0, 192, false)]
    [InlineData(341, 512, 192, 1.0, 192, true)]
    [InlineData(1024, 683, 192, 2.0, 384, false)]
    [InlineData(512, 400, 140, 1.5, 210, false)]
    [InlineData(600, 600, 100, 1.25, 125, true)]
    public void DecodesTheShortEdgeExactlyAtTheDisplayedSizeAndBelowTheSource(
        int width, int height, double cellDip, double scale, int displayedPixels, bool limitsWidth)
    {
        var decode = TileDecodeSize.For(width, height, cellDip, scale);
        Assert.Equal(limitsWidth ? new TileDecode(displayedPixels, null) : new TileDecode(null, displayedPixels), decode);
        Assert.True(displayedPixels < Math.Min(width, height));
        Assert.Equal(displayedPixels, TileDecodeSize.ShortEdgePixels(cellDip, scale));
    }

    [Theory]
    [InlineData(512, 341, 252, 2.0)]
    [InlineData(512, 512, 192, 3.0)]
    public void SourceNoLargerThanTheDisplayedSizeIsLeftAlone(int width, int height, double cellDip, double scale) =>
        Assert.Equal(default, TileDecodeSize.For(width, height, cellDip, scale));

    [Theory]
    [InlineData(double.NaN, 1.0)]
    [InlineData(192, double.NaN)]
    [InlineData(0, 1.0)]
    [InlineData(192, 0)]
    [InlineData(-192, 1.0)]
    [InlineData(192, -1.5)]
    [InlineData(double.PositiveInfinity, 1.0)]
    [InlineData(192, double.PositiveInfinity)]
    [InlineData(double.NegativeInfinity, 1.0)]
    public void NonPositiveOrNonFiniteCellOrScaleIsLeftAlone(double cellDip, double scale)
    {
        Assert.Equal(default, TileDecodeSize.For(512, 341, cellDip, scale));
        var path = WritePng("invalid.png", 512, 341);
        Assert.Equal(default, TileDecodeSize.ForFile(path, cellDip, scale));
    }

    [Fact]
    public void UnknownOrEmptySourceSizeIsLeftAlone()
    {
        Assert.Equal(default, TileDecodeSize.For(0, 512, 192, 1.0));
        Assert.Equal(default, TileDecodeSize.For(512, -1, 192, 1.0));
    }

    [Fact]
    public void PngHeaderSizeIsReadFromTheFile()
    {
        var path = WritePng("tile.png", 512, 341);
        Assert.Equal((512, 341), PngHeader.TryReadSize(path));
        Assert.Equal(new TileDecode(null, 192), TileDecodeSize.ForFile(path, 192, 1.0));
    }

    [Fact]
    public void FilesThatAreNotPngsOrAreMissingAreLeftAlone()
    {
        var notPng = Path.Combine(_directory, "tile.jpg");
        File.WriteAllBytes(notPng, new byte[64]);
        var truncated = Path.Combine(_directory, "short.png");
        File.WriteAllBytes(truncated, new byte[] { 0x89, 0x50, 0x4E, 0x47 });
        Assert.Null(PngHeader.TryReadSize(notPng));
        Assert.Null(PngHeader.TryReadSize(truncated));
        Assert.Null(PngHeader.TryReadSize(Path.Combine(_directory, "missing.png")));
        Assert.Equal(default, TileDecodeSize.ForFile(notPng, 192, 1.0));
    }

    private string WritePng(string name, int width, int height)
    {
        var header = new byte[24];
        new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }.CopyTo(header, 0);
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(8, 4), 13);
        "IHDR"u8.CopyTo(header.AsSpan(12, 4));
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(16, 4), width);
        BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(20, 4), height);
        var path = Path.Combine(_directory, name);
        File.WriteAllBytes(path, header);
        return path;
    }
}
