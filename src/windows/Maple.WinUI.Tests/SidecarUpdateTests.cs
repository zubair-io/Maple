using System.Security.Cryptography;
using System.Xml.Linq;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class SidecarUpdateTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "maple-metadata-" + Guid.NewGuid().ToString("N"));
    private string Raw => Path.Combine(_directory, "photo.dng");
    private string Sidecar => Path.ChangeExtension(Raw, ".xmp");

    public SidecarUpdateTests()
    {
        Directory.CreateDirectory(_directory);
        File.WriteAllBytes(Raw, new byte[] { 0, 1, 2, 3, 255 });
    }

    [Fact]
    public void AdjustmentAutosaveRetainsLatestKeywordsAndUnknownXml()
    {
        const string xml = """
            <x:xmpmeta xmlns:x="adobe:ns:meta/">
              <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
                <rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
                  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:vendor="urn:vendor"
                  crs:Exposure2012="0.5" vendor:Keep="unchanged">
                  <dc:subject><rdf:Bag><rdf:li>travel</rdf:li><rdf:li>東京</rdf:li></rdf:Bag></dc:subject>
                  <vendor:Payload vendor:Mode="keep"><vendor:Child>original</vendor:Child></vendor:Payload>
                </rdf:Description>
              </rdf:RDF>
            </x:xmpmeta>
            """;
        File.WriteAllText(Sidecar, xml);
        var hash = SHA256.HashData(File.ReadAllBytes(Raw));
        var written = SidecarStore.Update(Raw, doc =>
        {
            doc.Adjustments.Exposure = 1.25;
            doc.Rating = 4;
        });
        var result = XDocument.Parse(written);
        XNamespace rdf = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
        XNamespace vendor = "urn:vendor";
        Assert.Equal(new[] { "travel", "東京" }, result.Descendants(rdf + "li").Select(e => e.Value));
        Assert.Equal("unchanged", result.Descendants(rdf + "Description").Single().Attribute(vendor + "Keep")!.Value);
        Assert.Equal("original", result.Descendants(vendor + "Child").Single().Value);
        Assert.Equal(1.25, SidecarStore.Load(Raw)!.Adjustments.Exposure);
        Assert.Equal(4, SidecarStore.Load(Raw)!.Rating);
        Assert.Equal(hash, SHA256.HashData(File.ReadAllBytes(Raw)));
        Assert.Equal(written, File.ReadAllText(Sidecar));
    }

    [Fact]
    public void InvalidExistingSidecarIsNotReplacedByDefaults()
    {
        File.WriteAllText(Sidecar, "<broken");
        Assert.Throws<IOException>(() => SidecarStore.Update(Raw, doc => doc.Rating = 5));
        Assert.Equal("<broken", File.ReadAllText(Sidecar));
    }

    [Fact]
    public void NewSidecarAndSubsequentPatchKeepIndependentFields()
    {
        SidecarStore.Update(Raw, doc => doc.Adjustments.Exposure = 0.75);
        SidecarStore.Update(Raw, doc => doc.ColorLabel = "green");
        var loaded = SidecarStore.Load(Raw)!;
        Assert.Equal(0.75, loaded.Adjustments.Exposure);
        Assert.Equal("green", loaded.ColorLabel);
    }

    public void Dispose() => Directory.Delete(_directory, true);
}
