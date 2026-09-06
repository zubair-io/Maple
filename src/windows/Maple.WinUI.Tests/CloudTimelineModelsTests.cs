using System.Text.Json;
using Maple.WinUI.Services.Cloud;
using Xunit;

namespace Maple.WinUI.Tests;

public class CloudTimelineModelsTests
{
    [Fact]
    public void SearchWireShapePreservesCursorAddressCaptureAndCulling()
    {
        var page = JsonSerializer.Deserialize<CloudTimelinePage>("""
            {"results":[{"address":"photos:Trip/one.dng","abs_path":"/archive/Trip/one.dng",
             "filename":"one.dng","size":1234,"mtime":1704067200000,"captured_at":"2024-01-01T12:00:00Z",
             "camera":{"make":"Hasselblad","model":"L3D-100c"},"rating":4,"flag":-1,"color_label":"red"}],
             "nextCursor":"opaque+/=cursor"}
            """)!;
        var photo = Assert.Single(page.Results);
        Assert.Equal("opaque+/=cursor", page.NextCursor);
        Assert.Equal("photos:Trip/one.dng", photo.Address);
        Assert.Equal("/archive/Trip/one.dng", photo.Path);
        Assert.Equal(1704067200000, photo.Mtime);
        Assert.Equal("2024-01-01T12:00:00Z", photo.CapturedAt);
        Assert.Equal("L3D-100c", photo.Camera!.Model);
        Assert.Equal(4, photo.Rating);
        Assert.Equal(-1, photo.Flag);
        Assert.Equal("red", photo.ColorLabel);
    }

    [Fact]
    public void EmptyFinalPageAndUnindexedMetadataAreAccepted()
    {
        var empty = JsonSerializer.Deserialize<CloudTimelinePage>("""{"results":[],"nextCursor":null}""")!;
        Assert.Empty(empty.Results);
        Assert.Null(empty.NextCursor);
        var photo = JsonSerializer.Deserialize<CloudTimelinePhoto>("""{"filename":"one.jpg","camera":null,"captured_at":null,"address":null}""")!;
        Assert.Null(photo.CapturedAt);
        Assert.Null(photo.Camera);
        Assert.Null(photo.Address);
    }
}
