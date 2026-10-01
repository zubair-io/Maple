using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Native;
using Xunit;

namespace Maple.WinUI.Tests.Native;

public class MaskGroupFlatTests
{
    private static readonly LinearMask Linear = new(new(0.1, 0.2), new(0.9, 0.8), 0.4);
    private static readonly RadialMask Radial = new(new(0.5, 0.5), new(0.2, 0.3), 0, 0.5, false);

    [Fact]
    public void HeaderCarriesControlsAndLeavesHaveOnlyGeometry()
    {
        var group = new MaskGroup(new[] {
            new MaskComponent(Radial), new MaskComponent(Linear, MaskCombine.Subtract, true)
        }, 0.6, true);
        var flat = LocalAdjustmentFlat.ToFlat(new[] {
            new LocalAdjustment(group, new PartialAdjustments { Exposure = 1, Texture = 12 }),
            new LocalAdjustment(Linear, new PartialAdjustments { Contrast = 17 })
        });
        Assert.Equal(160, flat.Length);
        Assert.Equal(2f, flat[0]);
        Assert.Equal(0.6f, flat[1]);
        Assert.Equal(4f, flat[6]);
        Assert.Equal(1f, flat[7]);
        Assert.Equal(1f, flat[12]);
        Assert.Equal(12f, flat[32]);
        Assert.Equal(6f, flat[46]); // radial Add
        Assert.Equal(21f, flat[86]); // linear Subtract + invert
        Assert.Equal(0f, flat[48]);
        Assert.Equal(0f, flat[88]);
        Assert.Equal(17f, flat[133]); // following logical layer
    }

    [Fact]
    public void GroupEqualityIsStructuralAndInputsCannotMutateIt()
    {
        var components = new[] { new MaskComponent(Linear, MaskCombine.Intersect) };
        var group = new MaskGroup(components);
        components[0] = new MaskComponent(Radial);
        Assert.Equal(new MaskGroup(new[] { new MaskComponent(Linear, MaskCombine.Intersect) }), group);
        Assert.Throws<ArgumentException>(() => new MaskComponent(group));
        Assert.Throws<ArgumentOutOfRangeException>(() => new MaskComponent(Linear, (MaskCombine)9));
    }
}
