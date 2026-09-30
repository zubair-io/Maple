using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Export;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class XmpFilmTests
{
    [Theory]
    [InlineData("slide_fuji_velvia_50", 0)]
    [InlineData("black_white_kodak_tri_x_400", 65)]
    [InlineData("future:<look&name>\"", 100)]
    public void FilmFieldsRoundTripWithoutPassthroughDuplicates(string id, double strength)
    {
        var document = new XmpSidecarDocument { Adjustments = new() { FilmLook = id, FilmStrength = strength } };
        var xml = XmpWriter.Serialize(document);
        var loaded = XmpParser.Parse(xml)!;
        Assert.Equal(id, loaded.Adjustments.FilmLook);
        Assert.Equal(strength, loaded.Adjustments.FilmStrength);
        Assert.DoesNotContain(loaded.PassthroughAttributes, a => a.Name is "papp:FilmLook" or "papp:FilmStrength");
        Assert.Equal(xml, XmpWriter.Serialize(loaded));
        var snapshot = loaded.Adjustments.Clone();
        loaded.Adjustments.FilmLook = "";
        loaded.Adjustments.FilmStrength = 12;
        Assert.Equal(id, snapshot.FilmLook);
        Assert.Equal(strength, snapshot.FilmStrength);
        var decode = RenderEngine.StripChainStages(snapshot);
        Assert.Equal("", decode.FilmLook);
        Assert.Equal(100, decode.FilmStrength);
        Assert.False(RenderEngine.DecodeInputsChanged(snapshot, decode));
    }

    [Fact]
    public void DefaultsOmitFilmAndRestoreTheSharedDefaultStrength()
    {
        var xml = XmpWriter.Serialize(new());
        Assert.DoesNotContain("papp:Film", xml);
        var loaded = XmpParser.Parse(xml)!;
        Assert.Equal("", loaded.Adjustments.FilmLook);
        Assert.Equal(100, loaded.Adjustments.FilmStrength);
    }

    [Fact]
    public void ImportedFilmSurvivesRealSidecarMetadataWritesAndReset()
    {
        var directory = Path.Combine(Path.GetTempPath(), "maple-film-xmp-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var raw = Path.Combine(directory, "photo.dng");
            File.WriteAllBytes(raw, new byte[] { 1, 2, 3 });
            var xml = "<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description " +
                "xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" xmlns:vendor=\"urn:film-test\" " +
                "papp:FilmLook=\"slide_fuji_velvia_50\" papp:FilmStrength=\"65\" vendor:Keep=\"original\"/></rdf:RDF>";
            File.WriteAllText(SidecarStore.SidecarPathFor(raw), xml);
            SidecarStore.Update(raw, doc => doc.Rating = 4);
            var loaded = SidecarStore.Load(raw)!;
            Assert.Equal("slide_fuji_velvia_50", loaded.Adjustments.FilmLook);
            Assert.Equal(65, loaded.Adjustments.FilmStrength);
            Assert.Contains(loaded.PassthroughAttributes, a => a.Value == "original");
            SidecarStore.Update(raw, doc => { doc.Adjustments.FilmLook = ""; doc.Adjustments.FilmStrength = 100; });
            Assert.DoesNotContain("papp:Film", File.ReadAllText(SidecarStore.SidecarPathFor(raw)));
            Assert.Equal(new byte[] { 1, 2, 3 }, File.ReadAllBytes(raw));
        }
        finally { Directory.Delete(directory, true); }
    }

    [Fact]
    public void ExportCapturesCurrentFilmInsteadOfTheOlderSidecarSelection()
    {
        var document = new XmpSidecarDocument { Adjustments = new() { FilmLook = "slide_fuji_velvia_50", FilmStrength = 65 } };
        document.PassthroughAttributes.Add(new("custom", "retained"));
        var current = document.Adjustments.Clone();
        current.FilmLook = "black_white_kodak_tri_x_400";
        current.FilmStrength = 37;
        var frozen = ExportSnapshot.Serialize(XmpWriter.Serialize(document), current);
        current.FilmLook = "";
        current.FilmStrength = 100;
        var parsed = XmpParser.Parse(frozen)!;
        Assert.Equal("black_white_kodak_tri_x_400", parsed.Adjustments.FilmLook);
        Assert.Equal(37, parsed.Adjustments.FilmStrength);
        Assert.Contains(parsed.PassthroughAttributes, a => a.Name == "custom" && a.Value == "retained");
        var reset = ExportSnapshot.Serialize(frozen, current);
        Assert.DoesNotContain("papp:Film", reset);
    }
}
