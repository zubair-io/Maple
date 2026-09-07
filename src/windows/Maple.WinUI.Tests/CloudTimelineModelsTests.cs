using System;
using System.Collections.Generic;
using System.Linq;
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

    [Fact]
    public void FractionalFilesystemMtimeIsAcceptedWithoutRejectingThePage()
    {
        var page = JsonSerializer.Deserialize<CloudTimelinePage>("""
            {"results":[{"filename":"one.dng","mtime":1704067200123.456}],"nextCursor":null}
            """)!;
        var photo = Assert.Single(page.Results);
        Assert.Equal(1704067200123.456, photo.Mtime);
        Assert.Equal(new DateTimeOffset(2024, 1, 1, 0, 0, 0, TimeSpan.Zero).AddMilliseconds(123),
            DateTimeOffset.FromUnixTimeMilliseconds((long)photo.Mtime));
    }

    [Fact]
    public void PagingRemovesOverlapsAndDuplicatesInServerOrderWithOneExistingPathScan()
    {
        var reads = 0;
        IEnumerable<string> ExistingPaths()
        {
            for (var i = 0; i < 10_000; i++)
            {
                reads++;
                yield return $"/archive/{i}.dng";
            }
        }
        var page = new CloudTimelinePage
        {
            Results = new[] { "/archive/0.dng", "/archive/new.dng", "/archive/9999.dng",
                "/archive/new.dng", "/archive/NEW.dng", "/archive/last.dng" }
                .Select(path => new CloudTimelinePhoto { Path = path }).ToArray(),
        };
        Assert.Equal(new[] { "/archive/new.dng", "/archive/NEW.dng", "/archive/last.dng" },
            page.NewPhotos(ExistingPaths()).Select(photo => photo.Path));
        Assert.Equal(10_000, reads);
    }
}
