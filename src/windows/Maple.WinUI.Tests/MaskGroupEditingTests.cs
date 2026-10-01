using System;
using System.IO;
using System.Linq;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.Tests.Support;
using Xunit;

namespace Maple.WinUI.Tests
{
    public sealed class MaskGroupEditingTests
    {
        private static readonly LinearMask Linear = new(new(0.2, 0.3), new(0.8, 0.7), 0.5);
        private static readonly RadialMask Radial = new(new(0.5, 0.5), new(0.2, 0.3), 0.25, 0.5, false);

        [Fact]
        public void WrappingAndAppendingPreserveControlsRangeSlotsAndOriginalSnapshot()
        {
            var original = new LocalAdjustment(Linear, new PartialAdjustments { Exposure = 1 }, new(55, 25, 0.02, 0.15, 0.95, 0.3))
            { XmpGroupSlot = 7, XmpSource = "metadata" };
            var wrapped = MaskGroupEditing.Add(original, Radial, MaskCombine.Subtract);
            var group = Assert.IsType<MaskGroup>(wrapped.Mask);
            Assert.Equal(2, group.Components.Count);
            Assert.Equal(MaskCombine.Add, group.Components[0].Combine);
            Assert.Equal(MaskCombine.Subtract, group.Components[1].Combine);
            Assert.Equal(original.Adjustments, wrapped.Adjustments);
            Assert.Equal(original.Range, wrapped.Range);
            Assert.Equal(7, wrapped.XmpGroupSlot);
            Assert.Equal("metadata", wrapped.XmpSource);
            Assert.Equal(Linear, original.Mask);
            var translucent = MaskGroupEditing.WithOpacity(wrapped, 0.375);
            var inverted = MaskGroupEditing.WithGroupInverted(translucent, true);
            var appended = MaskGroupEditing.Add(inverted, Linear, MaskCombine.Intersect);
            var appendedGroup = Assert.IsType<MaskGroup>(appended.Mask);
            Assert.Equal(0.375, appendedGroup.Opacity);
            Assert.True(appendedGroup.Invert);
            Assert.Equal(3, appendedGroup.Components.Count);
            Assert.Equal(2, group.Components.Count);
        }

        [Fact]
        public void ComponentEditsPreserveMetadataAndDoNotMutateOtherComponents()
        {
            var component = new MaskComponent(Radial, MaskCombine.Subtract, true) { XmpSource = "leaf metadata" };
            var original = new LocalAdjustment(new MaskGroup(new[] { new MaskComponent(Linear), component }, 0.6, true), new());
            var moved = MaskGroupEditing.WithLeaf(original, 1, mask => Assert.IsType<RadialMask>(mask) with { Center = new(0.4, 0.3) });
            var combined = MaskGroupEditing.WithCombine(moved, 1, MaskCombine.Intersect);
            var inverted = MaskGroupEditing.WithComponentInverted(combined, 1, false);
            var group = Assert.IsType<MaskGroup>(inverted.Mask);
            Assert.Equal(Linear, group.Components[0].Mask);
            Assert.Equal(new MaskPoint(0.4, 0.3), Assert.IsType<RadialMask>(group.Components[1].Mask).Center);
            Assert.Equal("leaf metadata", group.Components[1].XmpSource);
            Assert.Equal(MaskCombine.Intersect, group.Components[1].Combine);
            Assert.False(group.Components[1].Invert);
            Assert.Equal(0.6, group.Opacity);
            Assert.True(group.Invert);
            Assert.Equal(Radial, Assert.IsType<MaskGroup>(original.Mask).Components[1].Mask);
            Assert.Equal(Radial, MaskGroupEditing.SelectedLeaf(original, 1));
            Assert.Null(MaskGroupEditing.SelectedLeaf(original, 9));
        }

        [Fact]
        public void RemovingLastOrInvalidComponentsIsANoOpAndOpacityIsFiniteClamped()
        {
            var layer = new LocalAdjustment(new MaskGroup(new[] { new MaskComponent(Linear) }), new());
            Assert.Same(layer, MaskGroupEditing.Remove(layer, 0));
            Assert.Same(layer, MaskGroupEditing.Remove(layer, -1));
            Assert.Same(layer, MaskGroupEditing.WithCombine(layer, 3, MaskCombine.Subtract));
            Assert.Same(layer, MaskGroupEditing.WithOpacity(layer, double.NaN));
            Assert.Equal(1, Assert.IsType<MaskGroup>(MaskGroupEditing.WithOpacity(layer, 2).Mask).Opacity);
            var pair = MaskGroupEditing.Add(layer, Radial, MaskCombine.Add);
            Assert.Equal(Radial, Assert.Single(Assert.IsType<MaskGroup>(MaskGroupEditing.Remove(pair, 0).Mask).Components).Mask);
        }

        [Fact]
        public void EditingImportedComponentsSurvivesARealSidecarSave()
        {
            var directory = Path.Combine(Path.GetTempPath(), "mask-group-edit-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            try
            {
                var raw = Path.Combine(directory, "photo.dng");
                var fixture = Path.Combine(Assert.IsType<string>(RepoPaths.FindRepoRoot()), "test-fixtures", "local-adjustments", "lightroom-group-subtract.xmp");
                File.Copy(fixture, SidecarStore.SidecarPathFor(raw));
                var doc = Assert.IsType<XmpSidecarDocument>(SidecarStore.Load(raw));
                var original = Assert.Single(doc.Adjustments.LocalAdjustments);
                doc.Adjustments.LocalAdjustments[0] = MaskGroupEditing.WithLeaf(original, 0,
                    mask => Assert.IsType<RadialMask>(mask) with { Feather = 0.75 });
                SidecarStore.Save(raw, doc);
                var saved = Assert.Single(Assert.IsType<XmpSidecarDocument>(SidecarStore.Load(raw)).Adjustments.LocalAdjustments);
                var group = Assert.IsType<MaskGroup>(saved.Mask);
                Assert.Equal(0.75, Assert.IsType<RadialMask>(group.Components[0].Mask).Feather);
                Assert.Equal(MaskCombine.Subtract, group.Components[1].Combine);
                Assert.Contains("Radial reference", File.ReadAllText(SidecarStore.SidecarPathFor(raw)));
                Assert.Contains("CorrectionSyncID", File.ReadAllText(SidecarStore.SidecarPathFor(raw)));
                Assert.False(File.Exists(raw));
            }
            finally { Directory.Delete(directory, recursive: true); }
        }
    }
}
