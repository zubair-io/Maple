using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class XmpAuthoredCullingTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "maple-authored-culling-" + Guid.NewGuid().ToString("N"));
    private string Raw => Path.Combine(_directory, "IMG_0001.dng");
    private string Sidecar => Path.ChangeExtension(Raw, ".xmp");

    public XmpAuthoredCullingTests()
    {
        Directory.CreateDirectory(_directory);
        File.WriteAllBytes(Raw, new byte[] { 0, 1, 2, 3 });
    }

    public void Dispose() => Directory.Delete(_directory, recursive: true);

    private static string LightroomSidecar(string culling) => $"""
        <?xml version="1.0" encoding="UTF-8"?>
        <x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0-c000">
         <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description rdf:about=""
            xmlns:xmp="http://ns.adobe.com/xap/1.0/"
            xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
            {culling}
            crs:Version="15.0"
            crs:Exposure2012="+0.50">
          </rdf:Description>
         </rdf:RDF>
        </x:xmpmeta>
        """;

    private string Saved(string source, Action<XmpSidecarDocument> edit)
    {
        File.WriteAllText(Sidecar, source);
        return SidecarStore.Update(Raw, edit);
    }

    private static int Count(string xml, string attribute) => xml.Split(attribute + "=").Length - 1;

    [Fact]
    public void LightroomRejectAndRedLabelSurviveAnExposureEdit()
    {
        var source = LightroomSidecar("xmp:Rating=\"-1\" xmp:Label=\"Red\"");
        var loaded = XmpParser.Parse(source)!;
        Assert.Null(loaded.Rating);
        Assert.Null(loaded.Flag);
        Assert.Equal("red", loaded.ColorLabel);

        var xml = Saved(source, doc => doc.Adjustments.Exposure = 1.25);

        Assert.Contains("xmp:Rating=\"-1\"", xml);
        Assert.Contains("xmp:Label=\"Red\"", xml);
        Assert.Equal(1, Count(xml, "xmp:Rating"));
        Assert.Equal(1, Count(xml, "xmp:Label"));
        Assert.DoesNotContain("papp:Flag=", xml);
        Assert.Equal(1.25, SidecarStore.Load(Raw)!.Adjustments.Exposure);
    }

    [Fact]
    public void UnchangedFractionalRatingKeepsItsBytes()
    {
        var xml = Saved(LightroomSidecar("xmp:Rating=\"3.0\""), doc => doc.Adjustments.Exposure = 0.75);
        Assert.Contains("xmp:Rating=\"3.0\"", xml);
        Assert.Equal(3, SidecarStore.Load(Raw)!.Rating);
    }

    [Fact]
    public void RatingEditRewritesTheRatingCanonically()
    {
        var xml = Saved(LightroomSidecar("xmp:Rating=\"-1\""), doc => doc.Rating = 4);
        Assert.Contains("xmp:Rating=\"4\"", xml);
        Assert.DoesNotContain("xmp:Rating=\"-1\"", xml);
    }

    [Fact]
    public void ClearingAnEditedRatingOmitsIt()
    {
        var xml = Saved(LightroomSidecar("xmp:Rating=\"3\""), doc => doc.Rating = null);
        Assert.DoesNotContain("xmp:Rating=", xml);
    }

    [Fact]
    public void ColourLabelEditReplacesTheContradictedAdobeWord()
    {
        var xml = Saved(LightroomSidecar("xmp:Label=\"Red\""), doc => doc.ColorLabel = "blue");
        Assert.DoesNotContain("xmp:Label=", xml);
        Assert.Contains("papp:ColorLabel=\"blue\"", xml);
        Assert.Equal("blue", SidecarStore.Load(Raw)!.ColorLabel);
    }

    [Fact]
    public void ClearingTheColourLabelDropsTheAdobeWord()
    {
        var xml = Saved(LightroomSidecar("xmp:Label=\"Red\""), doc => doc.ColorLabel = null);
        Assert.DoesNotContain("xmp:Label=", xml);
        Assert.Null(SidecarStore.Load(Raw)!.ColorLabel);
    }

    [Fact]
    public void CustomLabelWordSurvivesAColourLabelEdit()
    {
        var xml = Saved(LightroomSidecar("xmp:Label=\"To Do\""), doc => doc.ColorLabel = "green");
        Assert.Contains("xmp:Label=\"To Do\"", xml);
        Assert.Contains("papp:ColorLabel=\"green\"", xml);
    }
}
