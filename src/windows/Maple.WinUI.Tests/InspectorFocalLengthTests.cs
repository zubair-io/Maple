using System.Globalization;
using System.Text.Json;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.Metadata;
using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class InspectorFocalLengthTests
{
    [Theory]
    [InlineData(null, "—")]
    [InlineData(0.0, "—")]
    [InlineData(-35.0, "—")]
    [InlineData(double.NaN, "—")]
    [InlineData(double.PositiveInfinity, "—")]
    [InlineData(35.0, "35 mm")]
    [InlineData(24.75, "24.75 mm")]
    public void FocalLengthHasUnitsAndHonestAbsentState(double? value, string expected)
    {
        var previous = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("fr-FR");
            Assert.Equal(expected, new PhotoItem { FocalLengthMm = value }.FocalLengthDisplay);
        }
        finally { CultureInfo.CurrentCulture = previous; }
    }

    [Fact]
    public void AsyncFocalHydrationNotifiesDisplayedValue()
    {
        var photo = new PhotoItem();
        var changed = new List<string?>();
        photo.PropertyChanged += (_, e) => changed.Add(e.PropertyName);
        photo.FocalLengthMm = 85;
        Assert.Contains(nameof(PhotoItem.FocalLengthDisplay), changed);
        Assert.Equal("85 mm", photo.FocalLengthDisplay);
    }

    [Fact]
    public void BothCloudWireShapesRetainFractionalFocalLength()
    {
        const string json = "{\"focal_length\":24.75}";
        Assert.Equal(24.75, JsonSerializer.Deserialize<CloudDirExif>(json)!.FocalLengthMm);
        Assert.Equal(24.75, JsonSerializer.Deserialize<CloudTimelinePhoto>(json)!.FocalLengthMm);
        Assert.Null(JsonSerializer.Deserialize<CloudDirExif>("{}")!.FocalLengthMm);
        Assert.Null(JsonSerializer.Deserialize<CloudTimelinePhoto>("{}")!.FocalLengthMm);
    }

    [Fact]
    public void LocalTiffRationalReachesDisplayWithoutDevelopingOrWritingOriginal()
    {
        var path = Path.Combine(Path.GetTempPath(), "maple-focal-" + Guid.NewGuid().ToString("N") + ".dng");
        // One real little-endian TIFF IFD with EXIF FocalLength RATIONAL 99/4.
        byte[] bytes = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0,
            0x0a, 0x92, 5, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0,
            99, 0, 0, 0, 4, 0, 0, 0];
        try
        {
            File.WriteAllBytes(path, bytes);
            var exif = ExifReader.Read(path);
            Assert.NotNull(exif);
            Assert.Equal("24.75 mm", new PhotoItem { FocalLengthMm = exif.FocalLengthMm }.FocalLengthDisplay);
            Assert.Equal(bytes, File.ReadAllBytes(path));
            Assert.False(File.Exists(Path.ChangeExtension(path, ".xmp")));
        }
        finally { File.Delete(path); }
    }
}
