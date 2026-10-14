// Focused regression tests for adding modeled masks beside passthrough brushes.

using System;
using System.Linq;
using System.Xml.Linq;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests
{
    public sealed partial class XmpLayerOrderTests
    {
        [Fact]
        public void AppendingAModeledLayerAfterAnUnkeyedBrushKeepsTheStackOrder()
        {
            var brush = Container("papp:BrushCorrections", Correction(null, 0.3, BrushLeaf));
            var doc = Load(XmpLocalAdjustmentsTests.Sidecar(brush));
            Assert.IsType<BrushMask>(Assert.Single(doc.Adjustments.LocalAdjustments).Mask);
            doc.Adjustments.LocalAdjustments.Add(Linear(0.4));

            var first = Save(doc);
            var description = XDocument.Parse(first).Descendants(Rdf + "Description").First();
            var children = description.Elements().ToArray();
            Assert.True(Array.FindIndex(children, child => child.Name.LocalName == "BrushCorrections") <
                Array.FindIndex(children, child => child.Name.LocalName == "GradientBasedCorrections"));

            var reopened = Assert.IsType<XmpSidecarDocument>(SidecarStore.Load(Raw));
            Assert.IsType<BrushMask>(reopened.Adjustments.LocalAdjustments[0].Mask);
            Assert.IsType<LinearMask>(reopened.Adjustments.LocalAdjustments[1].Mask);
            Assert.Equal(first, Save(reopened));
        }
    }
}
