using System.Text.Json;
using System.Xml;
using Maple.WinUI.Services.Cloud;
using Maple.WinUI.Services.Metadata;
using Maple.WinUI.ViewModels;
using Xunit;

namespace Maple.WinUI.Tests;

public class DesignInteractionTests
{
    [Fact]
    public void CompareTapLatchesAndHoldRestoresPriorState()
    {
        var gesture = new ComparisonGesture();
        gesture.Press(0);
        Assert.True(gesture.ShowingBefore);
        gesture.Release(300);
        Assert.False(gesture.ShowingBefore);
        gesture.Press(400);
        gesture.Release(699);
        Assert.True(gesture.Latched);
        gesture.Press(800);
        gesture.Release(1200);
        Assert.True(gesture.Latched);
        gesture.Press(1300);
        gesture.Release(1350);
        Assert.False(gesture.ShowingBefore);
    }

    [Fact]
    public void CompareKeyRepeatDoesNotTurnHoldIntoTapAndCancellationNeverLatches()
    {
        var gesture = new ComparisonGesture();
        gesture.Press(0);
        gesture.Press(280);
        gesture.Release(310);
        Assert.False(gesture.Latched);
        gesture.Press(400);
        gesture.Cancel();
        gesture.Release(410);
        Assert.False(gesture.ShowingBefore);
        gesture.Toggle();
        gesture.Reset();
        Assert.False(gesture.ShowingBefore);
    }

    [Fact]
    public void BrowseSortUsesFallbackAndDeterministicTieBreakWithoutChangingItems()
    {
        var a = new PhotoItem { FilePath = "a", FileName = "a.dng", Rating = 4, CaptureDate = new DateTime(2026, 1, 2) };
        var b = new PhotoItem { FilePath = "b", FileName = "b.dng", Rating = 4, FileModifiedUtc = new DateTime(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc) };
        var c = new PhotoItem { FilePath = "c", FileName = "c.dng", Rating = 5, CaptureDate = new DateTime(2026, 1, 3) };
        var input = new[] { b, c, a };
        Assert.Equal(new[] { a, b, c }, BrowseSortLogic.Order(input, BrowseSort.Name));
        Assert.Equal(new[] { c, a, b }, BrowseSortLogic.Order(input, BrowseSort.CapturedNewest));
        Assert.Equal(new[] { b, a, c }, BrowseSortLogic.Order(input, BrowseSort.CapturedOldest));
        Assert.Equal(new[] { c, a, b }, BrowseSortLogic.Order(input, BrowseSort.Rating));
        Assert.Equal(new[] { b, c, a }, input);
        Assert.Null(b.CaptureDate);
    }

    [Fact]
    public void InspectorReadsRealSidecarWithoutRewritingUnknownXml()
    {
        var path = Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".xmp");
        const string xml = """
            <x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
              xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:exif="http://ns.adobe.com/exif/1.0/"
              xmlns:ps="http://ns.adobe.com/photoshop/1.0/" xmlns:private="urn:private">
              <rdf:RDF><rdf:Description ps:City="Paris" exif:GPSLatitude="48,51N" exif:GPSLongitude="2,21E">
                <dc:description><rdf:Alt><rdf:li xml:lang="x-default">Sunset &amp; sky</rdf:li></rdf:Alt></dc:description>
                <dc:subject><rdf:Bag><rdf:li>Landscape</rdf:li><rdf:li>Golden hour</rdf:li></rdf:Bag></dc:subject>
                <private:keep untouched="yes">  value  </private:keep>
              </rdf:Description></rdf:RDF>
            </x:xmpmeta>
            """;
        try
        {
            File.WriteAllText(path, xml);
            var before = File.ReadAllBytes(path);
            var rows = InspectorMetadata.ReadXmp(File.ReadAllText(path)).ToDictionary(r => r.Label, r => r.Value);
            Assert.Equal("Sunset & sky", rows["Caption"]);
            Assert.Equal("Landscape, Golden hour", rows["Keywords"]);
            Assert.Equal("Paris", rows["Location"]);
            Assert.Equal("48,51N, 2,21E", rows["GPS"]);
            Assert.Equal(before, File.ReadAllBytes(path));
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public void InspectorDoesNotInventAbsentMetadataOrResolveExternalEntities()
    {
        Assert.Empty(InspectorMetadata.ReadXmp(null));
        Assert.Empty(InspectorMetadata.ReadXmp("<x/>"));
        Assert.Throws<XmlException>(() => InspectorMetadata.ReadXmp("<!DOCTYPE x [<!ENTITY external SYSTEM 'file:///secret'>]><x>&external;</x>"));
        Assert.Throws<XmlException>(() => InspectorMetadata.ReadXmp("<broken>"));
    }

    [Fact]
    public void CloudInspectorProjectsAvailableFieldsAndToleratesAbsentEnrichment()
    {
        var metadata = JsonSerializer.Deserialize<CloudInspectorMetadata>("""
            {"description":"Sunset","ocr_text":"Maple","faces":[{"name":"Alex"},{"name":"Alex"},{}],
             "place":{"display_name":"Paris, France","lat":48.85,"lon":2.35},"vision":{"tags":["sky","city",42]}}
            """);
        var rows = metadata!.Rows().ToDictionary(r => r.Label, r => r.Value);
        Assert.Equal("Alex", rows["People"]);
        Assert.Equal("Paris, France", rows["Location"]);
        Assert.Equal("48.85, 2.35", rows["GPS"]);
        Assert.Equal("sky, city", rows["Tags"]);
        Assert.Equal("Maple", rows["OCR"]);
        Assert.Empty(new CloudInspectorMetadata().Rows());
    }
}
