using System;
using System.IO;
using System.Linq;
using System.Xml.Linq;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public sealed class XmpMaskGroupTests : IDisposable
    {
        private readonly string directory = Path.Combine(Path.GetTempPath(), "maple-groups-" + Guid.NewGuid().ToString("N"));
        private string Raw => Path.Combine(directory, "photo.dng");
        private static readonly XNamespace Crs = XmpSchema.CrsNs;
        private static readonly XNamespace Rdf = XmpSchema.RdfNs;
        private const string Linear = "<rdf:li crs:What='Mask/Gradient' crs:ZeroX='0.28351' crs:ZeroY='0.422576' crs:FullX='0.52459' crs:FullY='0.422576'/>";

        public XmpMaskGroupTests()
        {
            Directory.CreateDirectory(directory);
            File.WriteAllBytes(Raw, new byte[] { 2, 3, 5, 7 });
        }

        private static string Pin(string attributes = "", string? leaf = null) =>
            $"<rdf:li><rdf:Description crs:What='Correction' crs:LocalExposure2012='0.5' {attributes}><crs:CorrectionMasks><rdf:Seq>{leaf ?? Linear}</rdf:Seq></crs:CorrectionMasks></rdf:Description></rdf:li>";
        private static string Container(string pins) => $"<crs:MaskGroupBasedCorrections><rdf:Seq>{pins}</rdf:Seq></crs:MaskGroupBasedCorrections>";
        private static string Document(string children) =>
            $"<x:xmpmeta xmlns:x='adobe:ns:meta/'><rdf:RDF xmlns:rdf='{XmpSchema.RdfNs}'><rdf:Description xmlns:crs='{XmpSchema.CrsNs}' xmlns:papp='{XmpSchema.PappNs}' xmlns:f='urn:foreign'>{children}</rdf:Description></rdf:RDF></x:xmpmeta>";

        private XmpSidecarDocument Load(string xml)
        {
            File.WriteAllText(SidecarStore.SidecarPathFor(Raw), xml);
            return Assert.IsType<XmpSidecarDocument>(SidecarStore.Load(Raw));
        }

        private XmpSidecarDocument SaveReload(XmpSidecarDocument doc)
        {
            SidecarStore.Save(Raw, doc);
            Assert.Equal(new byte[] { 2, 3, 5, 7 }, File.ReadAllBytes(Raw));
            return Assert.IsType<XmpSidecarDocument>(SidecarStore.Load(Raw));
        }

        [Theory]
        [InlineData("add", MaskCombine.Add)]
        [InlineData("subtract", MaskCombine.Subtract)]
        [InlineData("intersect", MaskCombine.Intersect)]
        public void NativeLightroomFilesRetainBothComponents(string variant, MaskCombine combine)
        {
            var root = Assert.IsType<string>(RepoPaths.FindRepoRoot());
            var doc = Load(File.ReadAllText(Path.Combine(root, "test-fixtures", "local-adjustments", "lightroom-group-" + variant + ".xmp")));
            var layer = Assert.Single(doc.Adjustments.LocalAdjustments);
            var group = Assert.IsType<MaskGroup>(layer.Mask);
            Assert.Equal(2, group.Components.Count);
            Assert.Equal(combine, group.Components[1].Combine);
            Assert.False(group.Components[1].Invert);
            var container = XDocument.Parse(File.ReadAllText(SidecarStore.SidecarPathFor(Raw)))
                .Descendants(Crs + "MaskGroupBasedCorrections").Single();
            Assert.IsType<MaskGroup>(Assert.Single(XmpLocalAdjustments.Parse(container, XmpLocalAdjustments.GroupContainer)).Mask);
            var radial = Assert.IsType<RadialMask>(group.Components[0].Mask);
            Assert.Equal(0.5, radial.Feather);
            Assert.False(radial.Invert);
            var before = LocalAdjustmentFlat.ToFlat(doc.Adjustments.LocalAdjustments);
            var saved = SaveReload(doc);
            Assert.Equal(before, LocalAdjustmentFlat.ToFlat(saved.Adjustments.LocalAdjustments));
            var xml = File.ReadAllText(SidecarStore.SidecarPathFor(Raw));
            Assert.Contains("Composition reference", xml);
            Assert.Contains("MaskSyncID", xml);
            Assert.Contains("LocalCurveRefineSaturation", xml);
            SidecarStore.Save(Raw, saved);
            Assert.Equal(xml, File.ReadAllText(SidecarStore.SidecarPathFor(Raw)));
        }

        [Theory]
        [InlineData("papp:MaskGroupVersion='2'", null)]
        [InlineData("papp:MaskGroupOpacity='NaN'", null)]
        [InlineData("papp:MaskGroupInverted='perhaps'", null)]
        [InlineData("", "crs:MaskBlendMode='2'")]
        [InlineData("", "crs:MaskBlendMode='1' crs:MaskValue='1'")]
        [InlineData("", "crs:MaskActive='false'")]
        [InlineData("", "crs:Version='3'")]
        public void InvalidOrFutureGroupsRemainByteExact(string attributes, string? leafAttributes)
        {
            var leaf = leafAttributes is null ? Linear : Linear.Replace("/>", " " + leafAttributes + "/>");
            var opaque = Pin(attributes, leaf);
            var doc = Load(Document(Container(opaque + Pin())));
            Assert.Single(doc.Adjustments.LocalAdjustments);
            doc.Adjustments.Exposure = 1;
            var saved = SaveReload(doc);
            Assert.Single(saved.Adjustments.LocalAdjustments);
            Assert.Contains(opaque, File.ReadAllText(SidecarStore.SidecarPathFor(Raw)));
        }

        [Theory]
        [InlineData("crs:Roundness='20'")]
        [InlineData("crs:Midpoint='25'")]
        [InlineData("crs:Feather='NaN'")]
        [InlineData("crs:Flipped='maybe'")]
        public void UnsupportedRadialSemanticsDoNotBecomeAnEllipse(string unsupported)
        {
            var leaf = $"<rdf:li crs:What='Mask/CircularGradient' crs:Top='0' crs:Left='0' crs:Bottom='1' crs:Right='1' {unsupported}/>";
            var pin = Pin(leaf: Linear + leaf);
            var doc = Load(Document(Container(pin)));
            Assert.Empty(doc.Adjustments.LocalAdjustments);
            SaveReload(doc);
            Assert.Contains(pin, File.ReadAllText(SidecarStore.SidecarPathFor(Raw)));
        }

        [Fact]
        public void EditingControlsPreservesForeignCorrectionAndLeafMetadata()
        {
            var leaf = Linear.Replace("/>", " f:ZeroX='foreign' crs:MaskName='my pin'><f:curve><![CDATA[<shape>]]></f:curve></rdf:li>");
            var pin = Pin("crs:CorrectionName='my group' f:CorrectionAmount='foreign'", leaf)
                .Replace("</rdf:Description>", "<f:history value='a &amp; b'/></rdf:Description>");
            var doc = Load(Document(Container(pin)));
            var layer = Assert.Single(doc.Adjustments.LocalAdjustments);
            var group = Assert.IsType<MaskGroup>(layer.Mask);
            doc.Adjustments.LocalAdjustments[0] = layer with
            {
                Mask = group with { Opacity = 0.375, Invert = true },
                Adjustments = layer.Adjustments with { Exposure = 1.25 },
            };
            var saved = SaveReload(doc);
            var savedLayer = Assert.Single(saved.Adjustments.LocalAdjustments);
            Assert.Equal(1.25, savedLayer.Adjustments.Exposure);
            var savedGroup = Assert.IsType<MaskGroup>(savedLayer.Mask);
            Assert.Equal(0.375, savedGroup.Opacity);
            Assert.True(savedGroup.Invert);
            var xml = XDocument.Load(SidecarStore.SidecarPathFor(Raw));
            XNamespace foreign = "urn:foreign";
            Assert.Equal("a & b", Assert.Single(xml.Descendants(foreign + "history")).Attribute("value")!.Value);
            Assert.Equal("<shape>", Assert.Single(xml.Descendants(foreign + "curve")).Value);
            Assert.Equal("foreign", Assert.Single(xml.Descendants(), e => e.Attribute(foreign + "ZeroX") is not null).Attribute(foreign + "ZeroX")!.Value);
        }

        [Fact]
        public void DeletingKnownSlotsKeepsOpaquePinsAndSeparateContainersInOrder()
        {
            var opaque = Pin("papp:MaskGroupVersion='9'").Replace("0.5", "0.7");
            var doc = Load(Document(Container(Pin() + opaque + Pin()) + "<f:between/>" + Container(Pin())));
            Assert.Equal(3, doc.Adjustments.LocalAdjustments.Count);
            doc.Adjustments.LocalAdjustments.RemoveAt(0);
            var fresh = new LocalAdjustment(new MaskGroup(new[] { new MaskComponent(new LinearMask(new(0, 0), new(1, 1), 0.5)) }), new PartialAdjustments { Exposure = 2 });
            doc.Adjustments.LocalAdjustments.Add(fresh);
            var saved = SaveReload(doc);
            var text = File.ReadAllText(SidecarStore.SidecarPathFor(Raw));
            Assert.Contains(opaque, text);
            var xml = XDocument.Parse(text);
            var primary = xml.Descendants(Rdf + "Description").First();
            Assert.Equal(new[] { Crs + "MaskGroupBasedCorrections", (XNamespace)"urn:foreign" + "between", Crs + "MaskGroupBasedCorrections" }, primary.Elements().Select(e => e.Name));
            Assert.Equal(3, saved.Adjustments.LocalAdjustments.Count);
            var containers = primary.Elements(Crs + "MaskGroupBasedCorrections").ToArray();
            Assert.Equal(2, containers[0].Element(Rdf + "Seq")!.Elements(Rdf + "li").Count());
            Assert.Equal(2, containers[1].Element(Rdf + "Seq")!.Elements(Rdf + "li").Count());
        }

        [Fact]
        public void RawRangesHandleCommentsQuotesCdataUnicodeAndCrLf()
        {
            var opaque = Pin("papp:MaskGroupVersion='7' f:text='雪 &gt; 日'")
                .Replace("</rdf:Description>", "<!-- </rdf:li> --><?foreign retained?><f:text><![CDATA[<rdf:li/>]]></f:text></rdf:Description>");
            var source = Document(Container(opaque + Pin())).Replace("><", ">\r\n<");
            var expected = opaque.Replace("><", ">\r\n<");
            var doc = Load(source);
            Assert.Single(doc.Adjustments.LocalAdjustments);
            SaveReload(doc);
            Assert.Contains(expected, File.ReadAllText(SidecarStore.SidecarPathFor(Raw)));
        }

        [Fact]
        public void AliasedRdfAndReservedForeignPrefixesKeepTheirNamespaceMeaning()
        {
            var source = Document(Container(Pin(leaf: Linear.Replace("/>", " rdf:What='foreign'/>") + "<r:li crs:What='Mask/Unknown'/>")))
                .Replace("xmlns:rdf=", "xmlns:r=").Replace("<rdf:", "<r:").Replace("</rdf:", "</r:")
                .Replace("xmlns:f='urn:foreign'", "xmlns:f='urn:foreign' xmlns:rdf='urn:foreign-rdf'");
            // The known first leaf plus an unsupported second leaf stays one opaque correction.
            var doc = Load(source);
            Assert.Empty(doc.Adjustments.LocalAdjustments);
            SaveReload(doc);
            var xml = XDocument.Load(SidecarStore.SidecarPathFor(Raw));
            Assert.Equal("foreign", Assert.Single(xml.Descendants(), e => e.Attribute((XNamespace)"urn:foreign-rdf" + "What") is not null).Attribute((XNamespace)"urn:foreign-rdf" + "What")!.Value);
            Assert.NotEmpty(xml.Descendants(Rdf + "Seq"));
        }

        [Fact]
        public void KnownAliasedGroupWritesCanonicalOwnedFieldsWithoutLosingForeignAttributes()
        {
            var source = Document(Container(Pin(leaf: Linear.Replace("/>", " rdf:What='foreign' maskmeta0:ZeroX='second'/>"))))
                .Replace("xmlns:rdf=", "xmlns:r=").Replace("<rdf:", "<r:").Replace("</rdf:", "</r:")
                .Replace("xmlns:f='urn:foreign'", "xmlns:f='urn:foreign' xmlns:rdf='urn:foreign-rdf' xmlns:maskmeta0='urn:second'");
            var doc = Load(source);
            Assert.Single(doc.Adjustments.LocalAdjustments);
            var saved = SaveReload(doc);
            Assert.Single(saved.Adjustments.LocalAdjustments);
            var text = File.ReadAllText(SidecarStore.SidecarPathFor(Raw));
            Assert.Contains("crs:LocalExposure2012=\"0.5\"", text);
            Assert.Contains("papp:MaskGroupVersion=\"1\"", text);
            var xml = XDocument.Parse(text);
            var leaf = Assert.Single(xml.Descendants(Rdf + "li"), e => e.Attribute(Crs + "What")?.Value == "Mask/Gradient");
            Assert.Equal("foreign", leaf.Attribute((XNamespace)"urn:foreign-rdf" + "What")!.Value);
            Assert.Equal("second", leaf.Attribute((XNamespace)"urn:second" + "ZeroX")!.Value);
            SidecarStore.Save(Raw, saved);
            Assert.Equal(text, File.ReadAllText(SidecarStore.SidecarPathFor(Raw)));
        }

        [Fact]
        public void FreshInvertedOperationsAndFollowingOrdinaryLayerRoundTrip()
        {
            var doc = new XmpSidecarDocument();
            doc.Adjustments.LocalAdjustments.Add(new LocalAdjustment(new MaskGroup(new[]
            {
                new MaskComponent(new RadialMask(new(0.55, 0.45), new(0.3, 0.25), 0.25, 0.35, true)),
                new MaskComponent(new LinearMask(new(0.28351, 0.422576), new(0.52459, 0.422576), 0.65), MaskCombine.Subtract, true),
                new MaskComponent(new LinearMask(new(0.1, 0.2), new(0.8, 0.9), 0.2), MaskCombine.Intersect, true),
            }, 0.625, true), new PartialAdjustments { Exposure = 0.5, Texture = 12.5 }, new(55, 25, 0.02, 0.15, 0.95, 0.3)));
            doc.Adjustments.LocalAdjustments.Add(XmpLocalAdjustmentsTests.LinearLayer);
            var saved = SaveReload(doc);
            Assert.Equal(2, saved.Adjustments.LocalAdjustments.Count);
            var layer = saved.Adjustments.LocalAdjustments[0];
            var group = Assert.IsType<MaskGroup>(layer.Mask);
            Assert.Equal(0.625, group.Opacity);
            Assert.True(group.Invert);
            Assert.True(group.Components[1].Invert);
            Assert.True(group.Components[2].Invert);
            Assert.Equal(MaskCombine.Intersect, group.Components[2].Combine);
            Assert.Equal(12.5, layer.Adjustments.Texture);
            Assert.Equal(doc.Adjustments.LocalAdjustments[0].Range, layer.Range);
            Assert.Equal(LocalAdjustmentFlat.ToFlat(new[] { doc.Adjustments.LocalAdjustments[0] }), LocalAdjustmentFlat.ToFlat(new[] { layer }));
        }

        [Fact]
        public void NewGroupCanBeSavedAlongsideASelfClosingImportedContainer()
        {
            var doc = Load(Document("<crs:MaskGroupBasedCorrections><rdf:Seq/></crs:MaskGroupBasedCorrections>"));
            doc.Adjustments.LocalAdjustments.Add(new LocalAdjustment(new MaskGroup(new[]
            {
                new MaskComponent(new LinearMask(new(0, 0), new(1, 1), 0.5)),
            }), new PartialAdjustments { Exposure = 1 }));
            Assert.Single(SaveReload(doc).Adjustments.LocalAdjustments);
            Assert.Equal(2, XDocument.Load(SidecarStore.SidecarPathFor(Raw)).Descendants(Crs + "MaskGroupBasedCorrections").Count());
        }

        public void Dispose() => Directory.Delete(directory, recursive: true);
    }
}
