using System.Globalization;
using System.Text.Json;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.Metadata;
using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class InspectorFocalLengthTests : IDisposable
{
    private readonly CultureInfo _originalCulture = CultureInfo.CurrentCulture;

    public InspectorFocalLengthTests()
    {
        CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("en-US");
    }

    public void Dispose() => CultureInfo.CurrentCulture = _originalCulture;

    [Theory]
    [InlineData(null, "—")]
    [InlineData(0.0, "—")]
    [InlineData(-35.0, "—")]
    [InlineData(double.NaN, "—")]
    [InlineData(double.PositiveInfinity, "—")]
    [InlineData(35.0, "35 mm")]
    [InlineData(24.75, "24,75 mm")]
    [InlineData(0.004, "0,004 mm")]
    [InlineData(0.0004, "0,0004 mm")]
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

    [Theory]
    [InlineData("en-US", "24.75 mm", "f/2.8")]
    [InlineData("fr-FR", "24,75 mm", "f/2,8")]
    public void FocalLengthUsesTheSameLocaleAsCameraMetadata(string culture, string focal, string aperture)
    {
        var previous = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo(culture);
            var photo = CloudPhotoMapper.FromDirectory(new CloudDirImage
            {
                Name = "photo.CR3", Path = "/library/photo.CR3",
                Exif = new CloudDirExif { FocalLengthMm = 24.75, Aperture = 2.8 },
            }, "library:photo.CR3");
            Assert.Equal(focal, photo.FocalLengthDisplay);
            Assert.Equal(aperture, photo.Aperture);
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

    [Theory]
    [InlineData(24.75, "24.75 mm")]
    [InlineData(null, "—")]
    public void ProductionCloudProjectionsRetainFocalLengthAndPhotoIdentity(double? focal, string display)
    {
        var directory = CloudPhotoMapper.FromDirectory(new CloudDirImage
        {
            Name = "photo.CR3", Path = "/library/photo.CR3", Ext = "cr3", Size = 123,
            Mtime = "2026-01-02T03:04:05Z",
            Exif = focal.HasValue ? new CloudDirExif { FocalLengthMm = focal } : null,
        }, "library:photo.CR3");
        var timeline = CloudPhotoMapper.FromTimeline(new CloudTimelinePhoto
        {
            Filename = "photo.CR3", Path = "/library/photo.CR3", Address = "library:photo.CR3",
            Size = 123, Mtime = 1767323045000, FocalLengthMm = focal,
            Rating = 4, Flag = -1, ColorLabel = "red",
        });
        foreach (var photo in new[] { directory, timeline })
        {
            Assert.Equal(focal, photo.FocalLengthMm);
            Assert.Equal(display, photo.FocalLengthDisplay);
            Assert.True(photo.IsCloud);
            Assert.Equal("library:photo.CR3", photo.CloudAddress);
            Assert.Equal("/library/photo.CR3", photo.FilePath);
            Assert.Equal("photo.CR3", photo.FileName);
            Assert.Equal("CR3", photo.Format);
            Assert.Equal(123, photo.FileSizeBytes);
            Assert.Equal(new DateTime(2026, 1, 2, 3, 4, 5, DateTimeKind.Utc), photo.FileModifiedUtc);
        }
        Assert.Equal(0, directory.Rating);
        Assert.Equal(4, timeline.Rating);
        Assert.Equal("reject", timeline.FlagStatus);
        Assert.Equal("red", timeline.ColorLabel);
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
