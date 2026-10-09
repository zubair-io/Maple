// XmpLayerOrderTests — `papp:LayerOrder` (#4427) keeps an interleaved local
// adjustment stack in model order across the per-kind XMP containers.
//
// `CanonicalOrderBlock` is the cross-language parity artifact: the same
// literal is `CANONICAL_ORDER_BLOCK` in `raw-core/src/xmp/tests_local_adjustments_order.rs`,
// and appears in `LocalAdjustmentOrderTests.swift` and `local-adjustments-order.spec.ts`.

using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests
{
    public sealed class XmpLayerOrderTests : IDisposable
    {
        private const string Indent = "      ";
        private static readonly XNamespace Rdf = XmpSchema.RdfNs;
        private static readonly XNamespace Crs = XmpSchema.CrsNs;
        private static readonly XNamespace Papp = XmpSchema.PappNs;

        private readonly string directory = Path.Combine(Path.GetTempPath(), "maple-layer-order-" + Guid.NewGuid().ToString("N"));
        private string Raw => Path.Combine(directory, "photo.dng");
        private string SidecarPath => SidecarStore.SidecarPathFor(Raw);

        public XmpLayerOrderTests()
        {
            Directory.CreateDirectory(directory);
            File.WriteAllBytes(Raw, new byte[] { 2, 3, 5, 7 });
        }

        public void Dispose() => Directory.Delete(directory, recursive: true);

        private static PartialAdjustments Exposure(double value) => new() { Exposure = value };

        private static LocalAdjustment Linear(double exposure) =>
            new(new LinearMask(new MaskPoint(0.2, 0.3), new MaskPoint(0.8, 0.7), 0.5), Exposure(exposure));

        private static LocalAdjustment Radial(double exposure) =>
            new(new RadialMask(new MaskPoint(0.5, 0.5), new MaskPoint(0.25, 0.125), 0, 0.5, false), Exposure(exposure));

        private static readonly string CanonicalOrderBlock = string.Join("\n", new[]
        {
            "      <crs:GradientBasedCorrections>",
            "        <rdf:Seq>",
            "          <rdf:li>",
            "            <rdf:Description",
            "              crs:What=\"Correction\"",
            "              crs:CorrectionAmount=\"1\"",
            "              crs:CorrectionActive=\"True\"",
            "              papp:LayerOrder=\"1\"",
            "              crs:LocalExposure2012=\"0.4\">",
            "              <crs:CorrectionMasks>",
            "                <rdf:Seq>",
            "                  <rdf:li",
            "                    crs:What=\"Mask/Gradient\"",
            "                    crs:MaskValue=\"1\"",
            "                    crs:ZeroX=\"0.2\" crs:ZeroY=\"0.3\"",
            "                    crs:FullX=\"0.8\" crs:FullY=\"0.7\"",
            "                    papp:LocalFeather=\"0.5\"/>",
            "                </rdf:Seq>",
            "              </crs:CorrectionMasks>",
            "            </rdf:Description>",
            "          </rdf:li>",
            "        </rdf:Seq>",
            "      </crs:GradientBasedCorrections>",
            "      <crs:CircularGradientBasedCorrections>",
            "        <rdf:Seq>",
            "          <rdf:li>",
            "            <rdf:Description",
            "              crs:What=\"Correction\"",
            "              crs:CorrectionAmount=\"1\"",
            "              crs:CorrectionActive=\"True\"",
            "              papp:LayerOrder=\"0\"",
            "              crs:LocalExposure2012=\"0.2\">",
            "              <crs:CorrectionMasks>",
            "                <rdf:Seq>",
            "                  <rdf:li",
            "                    crs:What=\"Mask/CircularGradient\"",
            "                    crs:MaskValue=\"1\"",
            "                    crs:Top=\"0.375\" crs:Left=\"0.25\" crs:Bottom=\"0.625\" crs:Right=\"0.75\"",
            "                    crs:Angle=\"0\" crs:Midpoint=\"50\" crs:Roundness=\"0\"",
            "                    crs:Feather=\"50\" crs:Flipped=\"False\"/>",
            "                </rdf:Seq>",
            "              </crs:CorrectionMasks>",
            "            </rdf:Description>",
            "          </rdf:li>",
            "        </rdf:Seq>",
            "      </crs:CircularGradientBasedCorrections>",
        });

        private static string Key(int? order) => order is { } key ? $" papp:LayerOrder=\"{key}\"" : "";

        private static string Correction(int? order, double exposure, string leaf) =>
            $"<rdf:li><rdf:Description crs:What=\"Correction\" crs:CorrectionAmount=\"1\" crs:CorrectionActive=\"True\"{Key(order)} " +
            $"crs:LocalExposure2012=\"{exposure.ToString(CultureInfo.InvariantCulture)}\"><crs:CorrectionMasks><rdf:Seq>{leaf}</rdf:Seq></crs:CorrectionMasks></rdf:Description></rdf:li>";

        private const string LinearLeaf =
            "<rdf:li crs:What=\"Mask/Gradient\" crs:MaskValue=\"1\" crs:ZeroX=\"0.2\" crs:ZeroY=\"0.3\" crs:FullX=\"0.8\" crs:FullY=\"0.7\" papp:LocalFeather=\"0.5\"/>";
        private const string RadialLeaf =
            "<rdf:li crs:What=\"Mask/CircularGradient\" crs:MaskValue=\"1\" crs:Top=\"0.375\" crs:Left=\"0.25\" crs:Bottom=\"0.625\" crs:Right=\"0.75\" " +
            "crs:Angle=\"0\" crs:Midpoint=\"50\" crs:Roundness=\"0\" crs:Feather=\"50\" crs:Flipped=\"False\"/>";
        private const string BrushLeaf =
            "<rdf:li crs:What=\"Mask/Paint\" crs:MaskValue=\"1\" papp:BrushVersion=\"1\" papp:Dabs=\"0.25 0.3 0.05 0.5 0.8 0\" papp:BrushDigest=\"0123456789abcdef\"/>";
        private const string BitmapLeaf =
            "<rdf:li crs:What=\"Mask/Image\" crs:MaskActive=\"True\" crs:MaskBlendMode=\"0\" crs:MaskValue=\"1\" papp:MaskSource=\"PersonSkin\" " +
            "papp:MaskPerson=\"0\" papp:MaskFacialSkin=\"True\" papp:MaskBodySkin=\"False\" papp:MaskModel=\"apple-vision-person-instance/1\" papp:MaskDigest=\"a1b2c3d4e5f60718\"/>";

        private static string Container(string tag, params string[] corrections) =>
            $"{Indent}<{tag}><rdf:Seq>{string.Concat(corrections)}</rdf:Seq></{tag}>";

        /// <summary>
        /// What Apple writes for its model stack brush(0.1), radial(0.2),
        /// bitmap(0.3), linear(0.4), radial(0.5): one container per kind, each
        /// correction stamped with its model index. `keys` overrides them.
        /// </summary>
        private static string AppleInterleaved(int?[] keys) => XmpLocalAdjustmentsTests.Sidecar(string.Join("\n", new[]
        {
            Container("crs:GradientBasedCorrections", Correction(keys[3], 0.4, LinearLeaf)),
            Container("crs:CircularGradientBasedCorrections",
                Correction(keys[1], 0.2, RadialLeaf), Correction(keys[4], 0.5, RadialLeaf)),
            Container("papp:BrushCorrections", Correction(keys[0], 0.1, BrushLeaf)),
            Container("crs:MaskGroupBasedCorrections",
                Correction(keys[2], 0.3, BitmapLeaf).Replace("crs:CorrectionActive=\"True\"",
                    "crs:CorrectionActive=\"True\" papp:MaskGroupVersion=\"1\" papp:MaskGroupOpacity=\"1\" papp:MaskGroupInverted=\"False\"")),
        }));

        private static readonly int?[] ModelIndexes = { 0, 1, 2, 3, 4 };

        private XmpSidecarDocument Load(string xml)
        {
            File.WriteAllText(SidecarPath, xml);
            return Assert.IsType<XmpSidecarDocument>(SidecarStore.Load(Raw));
        }

        private string Save(XmpSidecarDocument doc)
        {
            SidecarStore.Save(Raw, doc);
            return File.ReadAllText(SidecarPath);
        }

        /// <summary>Every keyed correction across the four containers, as (kind, exposure) in key order.</summary>
        private static (string Kind, string Exposure)[] StackByKey(string xml)
        {
            var description = XDocument.Parse(xml).Descendants(Rdf + "Description").First();
            return description.Elements()
                .SelectMany(container => container.Elements(Rdf + "Seq").Elements(Rdf + "li").Elements(Rdf + "Description")
                    .Select(correction => (Kind: container.Name.LocalName, Correction: correction)))
                .Where(entry => entry.Correction.Attribute(Papp + "LayerOrder") is not null)
                .OrderBy(entry => double.Parse(entry.Correction.Attribute(Papp + "LayerOrder")!.Value, CultureInfo.InvariantCulture))
                .Select(entry => (entry.Kind, entry.Correction.Attribute(Crs + "LocalExposure2012")!.Value))
                .ToArray();
        }

        private static readonly (string, string)[] AppleStack =
        {
            ("BrushCorrections", "0.1"),
            ("CircularGradientBasedCorrections", "0.2"),
            ("MaskGroupBasedCorrections", "0.3"),
            ("GradientBasedCorrections", "0.4"),
            ("CircularGradientBasedCorrections", "0.5"),
        };

        [Fact]
        public void InterleavedStackWithPassthroughSurvivesSaveReopenSave()
        {
            var doc = Load(AppleInterleaved(ModelIndexes));
            Assert.Equal(new[] { Radial(0.2) with { XmpLayerOrder = 1 }, Linear(0.4) with { XmpLayerOrder = 3 },
                Radial(0.5) with { XmpLayerOrder = 4 } }, doc.Adjustments.LocalAdjustments);

            var first = Save(doc);
            Assert.Equal(AppleStack, StackByKey(first));
            Assert.Equal(5, Regex.Matches(first, "papp:LayerOrder=").Count);

            var reopened = Assert.IsType<XmpSidecarDocument>(SidecarStore.Load(Raw));
            Assert.Equal(doc.Adjustments.LocalAdjustments, reopened.Adjustments.LocalAdjustments);
            Assert.Equal(first, Save(reopened));
        }

        [Fact]
        public void DeletingALayerKeepsTheRestInPlaceAroundPassthroughCorrections()
        {
            var doc = Load(AppleInterleaved(ModelIndexes));
            doc.Adjustments.LocalAdjustments.RemoveAt(0);

            var first = Save(doc);
            Assert.Equal(AppleStack.Where(entry => entry.Item2 != "0.2"), StackByKey(first));

            var reopened = Assert.IsType<XmpSidecarDocument>(SidecarStore.Load(Raw));
            Assert.Equal(new[] { Linear(0.4) with { XmpLayerOrder = 3 }, Radial(0.5) with { XmpLayerOrder = 4 } },
                reopened.Adjustments.LocalAdjustments);
            Assert.Contains("papp:LayerOrder=\"0\"", first);
            Assert.Contains("papp:LayerOrder=\"2\"", first);
            Assert.Equal(first, Save(reopened));
        }

        [Fact]
        public void ANewLayerLandsDirectlyAboveTheModelLayerBeforeIt()
        {
            var doc = Load(AppleInterleaved(ModelIndexes));
            doc.Adjustments.LocalAdjustments.Insert(0, Linear(0.6));

            var first = Save(doc);
            Assert.Equal(AppleStack.Prepend(("GradientBasedCorrections", "0.6")), StackByKey(first));
            Assert.Contains("papp:LayerOrder=\"-1\"", first);
            Assert.Equal(first, Save(doc));

            var later = Assert.IsType<XmpSidecarDocument>(SidecarStore.Load(Raw));
            later.Adjustments.LocalAdjustments.Insert(2, Radial(0.8));
            var second = Save(later);
            Assert.Contains("papp:LayerOrder=\"1.5\"", second);
            Assert.Equal(new[]
            {
                ("GradientBasedCorrections", "0.6"),
                ("BrushCorrections", "0.1"),
                ("CircularGradientBasedCorrections", "0.2"),
                ("CircularGradientBasedCorrections", "0.8"),
                ("MaskGroupBasedCorrections", "0.3"),
                ("GradientBasedCorrections", "0.4"),
                ("CircularGradientBasedCorrections", "0.5"),
            }, StackByKey(second));
            Assert.Equal(second, Save(Assert.IsType<XmpSidecarDocument>(SidecarStore.Load(Raw))));
        }

        [Fact]
        public void InterleavedPairMatchesTheCrossLanguageLiteral()
        {
            var layers = new[] { Radial(0.2), Linear(0.4) };
            Assert.Equal(CanonicalOrderBlock, XmpLocalAdjustments.Serialize(layers, Indent));

            var doc = new XmpSidecarDocument();
            doc.Adjustments.LocalAdjustments.AddRange(layers);
            Assert.Contains(CanonicalOrderBlock, Save(doc));

            var parsed = Assert.IsType<XmpSidecarDocument>(XmpParser.Parse(XmpLocalAdjustmentsTests.Sidecar(CanonicalOrderBlock)));
            Assert.Equal(new[] { Radial(0.2) with { XmpLayerOrder = 0 }, Linear(0.4) with { XmpLayerOrder = 1 } },
                parsed.Adjustments.LocalAdjustments);
        }

        private static readonly string BrushV2Block = string.Join("\n", new[]
        {
            "      <papp:BrushCorrections>",
            "        <rdf:Seq>",
            "          <rdf:li>",
            "            <rdf:Description",
            "              crs:What=\"Correction\"",
            "              crs:CorrectionAmount=\"1\"",
            "              crs:CorrectionActive=\"True\"",
            "              papp:LayerOrder=\"1\"",
            "              crs:LocalExposure2012=\"0.3\">",
            "              <crs:CorrectionMasks>",
            "                <rdf:Seq>",
            "                  <rdf:li",
            "                    crs:What=\"Mask/Paint\"",
            "                    crs:MaskValue=\"1\"",
            "                    papp:BrushVersion=\"2\"",
            "                    papp:Dabs=\"0.25 0.3 0.05 0.5 0.8 0\"/>",
            "                </rdf:Seq>",
            "              </crs:CorrectionMasks>",
            "            </rdf:Description>",
            "          </rdf:li>",
            "        </rdf:Seq>",
            "      </papp:BrushCorrections>",
        });

        private static readonly string PassthroughOrderBlock = string.Join("\n", new[]
        {
            "      <crs:GradientBasedCorrections>",
            "        <rdf:Seq>",
            "          <rdf:li>",
            "            <rdf:Description",
            "              crs:What=\"Correction\"",
            "              crs:CorrectionAmount=\"1\"",
            "              crs:CorrectionActive=\"True\"",
            "              papp:LayerOrder=\"-1\"",
            "              crs:LocalExposure2012=\"0.1\">",
            "              <crs:CorrectionMasks>",
            "                <rdf:Seq>",
            "                  <rdf:li",
            "                    crs:What=\"Mask/Gradient\"",
            "                    crs:MaskValue=\"1\"",
            "                    crs:ZeroX=\"0.2\" crs:ZeroY=\"0.3\"",
            "                    crs:FullX=\"0.8\" crs:FullY=\"0.7\"",
            "                    papp:LocalFeather=\"0.5\"/>",
            "                </rdf:Seq>",
            "              </crs:CorrectionMasks>",
            "            </rdf:Description>",
            "          </rdf:li>",
            "          <rdf:li>",
            "            <rdf:Description",
            "              crs:What=\"Correction\"",
            "              crs:CorrectionAmount=\"1\"",
            "              crs:CorrectionActive=\"True\"",
            "              papp:LayerOrder=\"0\"",
            "              crs:LocalExposure2012=\"0.4\">",
            "              <crs:CorrectionMasks>",
            "                <rdf:Seq>",
            "                  <rdf:li",
            "                    crs:What=\"Mask/Gradient\"",
            "                    crs:MaskValue=\"1\"",
            "                    crs:ZeroX=\"0.2\" crs:ZeroY=\"0.3\"",
            "                    crs:FullX=\"0.8\" crs:FullY=\"0.7\"",
            "                    papp:LocalFeather=\"0.5\"/>",
            "                </rdf:Seq>",
            "              </crs:CorrectionMasks>",
            "            </rdf:Description>",
            "          </rdf:li>",
            "        </rdf:Seq>",
            "      </crs:GradientBasedCorrections>",
            "      <crs:CircularGradientBasedCorrections>",
            "        <rdf:Seq>",
            "          <rdf:li>",
            "            <rdf:Description",
            "              crs:What=\"Correction\"",
            "              crs:CorrectionAmount=\"1\"",
            "              crs:CorrectionActive=\"True\"",
            "              papp:LayerOrder=\"2\"",
            "              crs:LocalExposure2012=\"0.2\">",
            "              <crs:CorrectionMasks>",
            "                <rdf:Seq>",
            "                  <rdf:li",
            "                    crs:What=\"Mask/CircularGradient\"",
            "                    crs:MaskValue=\"1\"",
            "                    crs:Top=\"0.375\" crs:Left=\"0.25\" crs:Bottom=\"0.625\" crs:Right=\"0.75\"",
            "                    crs:Angle=\"0\" crs:Midpoint=\"50\" crs:Roundness=\"0\"",
            "                    crs:Feather=\"50\" crs:Flipped=\"False\"/>",
            "                </rdf:Seq>",
            "              </crs:CorrectionMasks>",
            "            </rdf:Description>",
            "          </rdf:li>",
            "        </rdf:Seq>",
            "      </crs:CircularGradientBasedCorrections>",
        });

        /// <summary>The shared passthrough fixture's input: linear 0, the unreadable brush 1, radial 2.</summary>
        private static string PassthroughInput() => XmpLocalAdjustmentsTests.Sidecar(string.Join("\n",
            CanonicalOrderBlock.Replace("papp:LayerOrder=\"0\"", "papp:LayerOrder=\"2\"")
                .Replace("papp:LayerOrder=\"1\"", "papp:LayerOrder=\"0\""),
            BrushV2Block));

        [Fact]
        public void PassthroughLiteralInsertingAtTheBottomKeepsTheVerbatimBrushUntouched()
        {
            var untouched = Brush(Save(Load(PassthroughInput())));
            var doc = Load(PassthroughInput());
            Assert.Equal(new[] { Linear(0.4) with { XmpLayerOrder = 0 }, Radial(0.2) with { XmpLayerOrder = 2 } },
                doc.Adjustments.LocalAdjustments);
            doc.Adjustments.LocalAdjustments.Insert(0, Linear(0.1));

            var first = Save(doc);
            Assert.Contains(PassthroughOrderBlock + "\n", first);
            Assert.Equal(untouched, Brush(first));
            Assert.True(XNode.DeepEquals(BrushElement(XmpLocalAdjustmentsTests.Sidecar(BrushV2Block)), BrushElement(first)));

            var reopened = Assert.IsType<XmpSidecarDocument>(SidecarStore.Load(Raw));
            Assert.Equal(new[] { Linear(0.1) with { XmpLayerOrder = -1 }, Linear(0.4) with { XmpLayerOrder = 0 },
                Radial(0.2) with { XmpLayerOrder = 2 } }, reopened.Adjustments.LocalAdjustments);
            Assert.Equal(first, Save(reopened));
        }

        [Fact]
        public void PassthroughLiteralSavedTwiceWithoutReopeningIsByteIdentical()
        {
            var doc = Load(PassthroughInput());
            doc.Adjustments.LocalAdjustments.Insert(0, Linear(0.1));
            var first = Save(doc);
            Assert.Equal(first, Save(doc));
            Assert.Contains(PassthroughOrderBlock + "\n", first);
        }

        [Fact]
        public void PassthroughLiteralDeletingTheLinearKeepsEveryOtherKey()
        {
            var doc = Load(PassthroughInput());
            doc.Adjustments.LocalAdjustments.RemoveAt(0);

            var first = Save(doc);
            Assert.True(XNode.DeepEquals(BrushElement(XmpLocalAdjustmentsTests.Sidecar(BrushV2Block)), BrushElement(first)));
            Assert.Contains("papp:LayerOrder=\"2\"", first);
            Assert.Equal(new[] { ("BrushCorrections", "0.3"), ("CircularGradientBasedCorrections", "0.2") }, StackByKey(first));

            var reopened = Assert.IsType<XmpSidecarDocument>(SidecarStore.Load(Raw));
            Assert.Equal(new[] { Radial(0.2) with { XmpLayerOrder = 2 } }, reopened.Adjustments.LocalAdjustments);
            Assert.Equal(first, Save(reopened));
            Assert.Equal(first, Save(doc));
        }

        private static string Brush(string xml)
        {
            var open = xml.IndexOf("<papp:BrushCorrections", StringComparison.Ordinal);
            var close = "</papp:BrushCorrections>";
            return xml[open..(xml.IndexOf(close, open, StringComparison.Ordinal) + close.Length)];
        }

        /// <summary>
        /// Windows passthrough re-serializes the container (attributes on one
        /// line, namespaces re-declared), so the literal is compared as XML.
        /// </summary>
        private static XElement BrushElement(string xml)
        {
            var element = new XElement(XDocument.Parse(xml, LoadOptions.PreserveWhitespace).Descendants(Papp + "BrushCorrections").Single());
            element.DescendantsAndSelf().Attributes().Where(attribute => attribute.IsNamespaceDeclaration).Remove();
            return element;
        }

        [Fact]
        public void AStackAlreadyInContainerOrderWritesNoKeys()
        {
            var doc = new XmpSidecarDocument();
            doc.Adjustments.LocalAdjustments.AddRange(new[] { Linear(0.4), Radial(0.2), Radial(0.5) });
            Assert.DoesNotContain("papp:LayerOrder", Save(doc));
        }

        [Fact]
        public void UnkeyedLegacySidecarLoadsInContainerOrderAndResavesByteIdentically()
        {
            var legacy = Load(AppleInterleaved(new int?[5]));
            Assert.Equal(new[] { Linear(0.4), Radial(0.2), Radial(0.5) }, legacy.Adjustments.LocalAdjustments);
            var first = Save(legacy);
            Assert.DoesNotContain("papp:LayerOrder", first);
            Assert.Equal(first, Save(Assert.IsType<XmpSidecarDocument>(SidecarStore.Load(Raw))));

            var canonical = XmpLocalAdjustmentsTests.Sidecar(XmpLocalAdjustmentsTests.CanonicalBlock);
            var resaved = Save(Load(canonical));
            Assert.Contains(XmpLocalAdjustmentsTests.CanonicalBlock, resaved);
            Assert.DoesNotContain("papp:LayerOrder", resaved);
            Assert.Equal(resaved, Save(Assert.IsType<XmpSidecarDocument>(SidecarStore.Load(Raw))));
        }

        [Fact]
        public void PartiallyKeyedSidecarLoadsInContainerOrder()
        {
            var doc = Load(AppleInterleaved(new int?[] { 0, 1, 2, 3, null }));
            Assert.Equal(new[] { Linear(0.4) with { XmpLayerOrder = 3 }, Radial(0.2) with { XmpLayerOrder = 1 }, Radial(0.5) },
                doc.Adjustments.LocalAdjustments);

            var first = Save(doc);
            var reopened = Assert.IsType<XmpSidecarDocument>(SidecarStore.Load(Raw));
            Assert.Equal(new[] { Linear(0.4) with { XmpLayerOrder = -1 }, Radial(0.2) with { XmpLayerOrder = 1 },
                Radial(0.5) with { XmpLayerOrder = 1.5 } }, reopened.Adjustments.LocalAdjustments);
            Assert.Equal(first, Save(reopened));
        }

        [Theory]
        [InlineData("x")]
        [InlineData("")]
        [InlineData("NaN")]
        [InlineData("1e400")]
        public void AnUnparseableKeyReadsAsAbsent(string raw)
        {
            var doc = Load(AppleInterleaved(ModelIndexes).Replace("papp:LayerOrder=\"3\"", $"papp:LayerOrder=\"{raw}\""));
            Assert.Equal(new[] { Linear(0.4), Radial(0.2) with { XmpLayerOrder = 1 }, Radial(0.5) with { XmpLayerOrder = 4 } },
                doc.Adjustments.LocalAdjustments);
        }

        [Fact]
        public void ModeledGroupCorrectionsCarryTheKeyExactlyOnce()
        {
            var group = Correction(5, 0.7, LinearLeaf).Replace("crs:CorrectionActive=\"True\"",
                "crs:CorrectionActive=\"True\" papp:MaskGroupVersion=\"1\" papp:MaskGroupOpacity=\"1\" papp:MaskGroupInverted=\"False\"");
            var xml = AppleInterleaved(ModelIndexes).Replace("</rdf:Seq></crs:MaskGroupBasedCorrections>",
                group + "</rdf:Seq></crs:MaskGroupBasedCorrections>");
            var doc = Load(xml);
            Assert.IsType<MaskGroup>(doc.Adjustments.LocalAdjustments[^1].Mask);
            Assert.Equal(5, doc.Adjustments.LocalAdjustments[^1].XmpLayerOrder);

            var first = Save(doc);
            Assert.Equal(AppleStack.Append(("MaskGroupBasedCorrections", "0.7")), StackByKey(first));
            var groups = XDocument.Parse(first).Descendants(Crs + "MaskGroupBasedCorrections").Single()
                .Elements(Rdf + "Seq").Elements(Rdf + "li").Elements(Rdf + "Description").ToArray();
            Assert.All(groups, correction => Assert.Single(correction.Attributes(), a => a.Name.LocalName == "LayerOrder"));
            Assert.Equal(first, Save(Assert.IsType<XmpSidecarDocument>(SidecarStore.Load(Raw))));
        }
    }
}
