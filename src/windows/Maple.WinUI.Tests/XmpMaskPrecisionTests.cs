using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public class XmpMaskPrecisionTests
{
    [Theory]
    [InlineData(-.0000001, "0")]
    [InlineData(-.1234567, "-0.123457")]
    [InlineData(1.25, "1.25")]
    public void CoordinatesKeepSignedOffFrameValuesWithoutNegativeZero(double value, string expected)
    {
        var document = new XmpSidecarDocument();
        document.Adjustments.LocalAdjustments.Add(new LocalAdjustment(
            new LinearMask(new(value, .5), new(.7, .5), .5), new()));
        Assert.Contains($"crs:ZeroX=\"{expected}\"", XmpWriter.Serialize(document));
    }

    [Fact]
    public void FineMaskCoordinatesSurviveRepeatedSidecarRoundTrips()
    {
        var document = new XmpSidecarDocument();
        document.Adjustments.LocalAdjustments.Add(new LocalAdjustment(
            new LinearMask(new(.300698, .500123), new(.700321, .499876), .5), new()));
        document.Adjustments.LocalAdjustments.Add(new LocalAdjustment(
            new RadialMask(new(.500698, .499876), new(.001234, .002345), 0, .5, false), new()));
        var xml = XmpWriter.Serialize(document);
        Assert.Contains("crs:ZeroX=\"0.300698\" crs:ZeroY=\"0.500123\"", xml);
        Assert.Contains("crs:Top=\"0.497531\" crs:Left=\"0.499464\" crs:Bottom=\"0.502221\" crs:Right=\"0.501932\"", xml);
        for (var i = 0; i < 5; i++)
        {
            var parsed = Assert.IsType<XmpSidecarDocument>(XmpParser.Parse(xml));
            Assert.Equal(2, parsed.Adjustments.LocalAdjustments.Count);
            var linear = Assert.IsType<LinearMask>(parsed.Adjustments.LocalAdjustments[0].Mask);
            var radial = Assert.IsType<RadialMask>(parsed.Adjustments.LocalAdjustments[1].Mask);
            Assert.Equal(.300698, linear.Start.X, 6);
            Assert.Equal(.700321, linear.End.X, 6);
            Assert.Equal(.001234, radial.Radii.X, 6);
            Assert.Equal(.002345, radial.Radii.Y, 6);
            Assert.Equal(xml, XmpWriter.Serialize(parsed));
            xml = XmpWriter.Serialize(parsed);
        }
    }
}
