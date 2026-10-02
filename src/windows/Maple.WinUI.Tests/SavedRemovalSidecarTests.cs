// #1472: Windows consumes portable saved edits; ordinary develop cannot author them.
using System.Xml.Linq;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Export;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class SavedRemovalSidecarTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "maple-windows-removal-xmp-" + Guid.NewGuid().ToString("N"));
    private string Raw => Path.Combine(root, "photo.dng");
    private string Sidecar => SidecarStore.SidecarPathFor(Raw);
    private readonly string records;

    public SavedRemovalSidecarTests()
    {
        var fixture = Path.Combine(AppContext.BaseDirectory, "Fixtures", "removal");
        Directory.CreateDirectory(root);
        File.Copy(Path.Combine(fixture, "source.dng"), Raw);
        var description = XElement.Parse(File.ReadAllText(Path.Combine(fixture, "saved.xmp")));
        records = description.Attribute(XNamespace.Get(XmpSchema.PappNs) + "InpaintRemovals")!.Value;
        description.SetAttributeValue(XNamespace.Get("urn:removal-fixture") + "Keep", "untouched");
        description.Add(new XElement(XNamespace.Get("urn:removal-fixture") + "History", new XAttribute("original", "preserved")));
        File.WriteAllText(Sidecar, new XElement(XNamespace.Get(XmpSchema.RdfNs) + "RDF", description).ToString());
    }

    public void Dispose() => Directory.Delete(root, recursive: true);

    [Fact]
    public void Decode_and_export_snapshots_keep_exact_records_without_duplicate_passthrough()
    {
        var doc = SidecarStore.Load(Raw)!;
        Assert.Equal(records, doc.Adjustments.InpaintRemovals);
        Assert.DoesNotContain(doc.PassthroughAttributes, attribute => attribute.Name == "papp:InpaintRemovals");
        doc.Adjustments.Exposure = 1.25;
        var stripped = RenderEngine.StripChainStages(doc.Adjustments);
        Assert.Equal(0, stripped.Exposure);
        Assert.Equal(records, stripped.InpaintRemovals);
        var serialized = ExportSnapshot.Serialize(File.ReadAllText(Sidecar), doc.Adjustments);
        var owned = XDocument.Parse(serialized).Descendants().Attributes(XNamespace.Get(XmpSchema.PappNs) + "InpaintRemovals");
        Assert.Equal(records, Assert.Single(owned).Value);
        Assert.Equal(1.25, XmpParser.Parse(serialized)!.Adjustments.Exposure);
    }

    [Fact]
    public void Ordinary_real_file_save_preserves_records_foreign_xml_and_original()
    {
        var original = File.ReadAllBytes(Raw);
        var doc = SidecarStore.Load(Raw)!;
        doc.Adjustments.Exposure = -1.25;
        doc.Rating = 5;
        SidecarStore.Save(Raw, doc);
        var reopened = SidecarStore.Load(Raw)!;
        Assert.Equal(records, reopened.Adjustments.InpaintRemovals);
        Assert.Equal(-1.25, reopened.Adjustments.Exposure);
        Assert.Equal(5, reopened.Rating);
        var xml = XDocument.Parse(File.ReadAllText(Sidecar));
        Assert.Equal("untouched", Assert.Single(xml.Descendants().Attributes(XNamespace.Get("urn:removal-fixture") + "Keep")).Value);
        Assert.Equal("preserved", Assert.Single(xml.Descendants(XNamespace.Get("urn:removal-fixture") + "History")).Attribute("original")!.Value);
        Assert.Equal(original, File.ReadAllBytes(Raw));
        Assert.Empty(Directory.GetFiles(root, "*.tmp"));
    }

    [Theory]
    [InlineData("clear")]
    [InlineData("replace")]
    [InlineData("later")]
    [InlineData("introduce")]
    public void Ordinary_save_and_active_export_refuse_changed_removal_history(string change)
    {
        var doc = SidecarStore.Load(Raw)!;
        var changed = records.Replace("\"schema\":4", "\"schema\":99");
        Assert.NotEqual(records, changed);
        if (change == "clear") doc.Adjustments.InpaintRemovals = null;
        if (change == "replace") doc.Adjustments.InpaintRemovals = changed;
        if (change == "later")
        {
            var remote = SidecarStore.Load(Raw)!;
            remote.Adjustments.InpaintRemovals = changed;
            File.WriteAllText(Sidecar, XmpWriter.Serialize(remote));
        }
        if (change == "introduce") File.Delete(Sidecar);
        var before = File.Exists(Sidecar) ? File.ReadAllText(Sidecar) : null;
        var original = File.ReadAllBytes(Raw);
        Assert.Throws<InvalidDataException>(() => SidecarStore.Save(Raw, doc));
        Assert.Throws<InvalidDataException>(() => ExportSnapshot.Serialize(before, doc.Adjustments));
        Assert.Equal(before, File.Exists(Sidecar) ? File.ReadAllText(Sidecar) : null);
        Assert.Equal(original, File.ReadAllBytes(Raw));
        Assert.Empty(Directory.GetFiles(root, "*.tmp"));
    }

    [Fact]
    public void Future_records_survive_parse_clone_and_write_for_shared_native_refusal()
    {
        var xml = File.ReadAllText(Sidecar).Replace("&quot;schema&quot;:4", "&quot;schema&quot;:99");
        var doc = XmpParser.Parse(xml)!;
        var future = records.Replace("\"schema\":4", "\"schema\":99");
        Assert.Equal(future, doc.Adjustments.InpaintRemovals);
        Assert.Equal(future, XmpParser.Parse(XmpWriter.Serialize(doc))!.Adjustments.InpaintRemovals);
        Assert.Equal(future, doc.Adjustments.Clone().InpaintRemovals);
    }

    [Fact]
    public void Namespace_uri_controls_ownership_and_stack_changes_invalidate_decode()
    {
        var description = XDocument.Parse(File.ReadAllText(Sidecar)).Descendants(XNamespace.Get(XmpSchema.RdfNs) + "Description").Single();
        description.Add(new XAttribute(XNamespace.Xmlns + "saved", XmpSchema.PappNs));
        var alias = XmpParser.Parse(new XElement(XNamespace.Get(XmpSchema.RdfNs) + "RDF", description).ToString())!.Adjustments;
        Assert.Equal(records, alias.InpaintRemovals);
        var exposure = alias.Clone();
        exposure.Exposure = 2;
        Assert.False(RenderEngine.DecodeInputsChanged(alias, exposure));
        exposure.InpaintRemovals = null;
        Assert.True(RenderEngine.DecodeInputsChanged(alias, exposure));
        description.Attribute(XNamespace.Get(XmpSchema.PappNs) + "InpaintRemovals")!.Remove();
        description.SetAttributeValue(XNamespace.Get("urn:untrusted") + "InpaintRemovals", records);
        var foreign = XmpParser.Parse(new XElement(XNamespace.Get(XmpSchema.RdfNs) + "RDF", description).ToString())!;
        Assert.Null(foreign.Adjustments.InpaintRemovals);
        Assert.Contains(foreign.PassthroughAttributes, attribute => attribute.Value == records);
    }
}
