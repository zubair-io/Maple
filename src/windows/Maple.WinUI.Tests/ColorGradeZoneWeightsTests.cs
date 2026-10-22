using Maple.UI;
using Xunit;

namespace Maple.WinUI.Tests;

public class ColorGradeZoneWeightsTests
{
    public static TheoryData<double, double, double, double, double, double, double, double> Goldens => new()
    {
        { 0.05, 0, 100, 0.564622, 0.564622, 0.977863, 0.022137, 0.000000 },
        { 0.3, 0, 100, 0.564622, 0.564622, 0.453068, 0.546932, 0.000000 },
        { 0.564622, 0, 100, 0.564622, 0.564622, 0.000000, 1.000000, 0.000000 },
        { 0.8, 0, 100, 0.564622, 0.564622, 0.000000, 0.439191, 0.560809 },
        { 0.25, 0, 50, 0.3, 0.7, 0.208630, 0.791370, 0.000000 },
        { 0.65, 0, 50, 0.3, 0.7, 0.000000, 1.000000, 0.000000 },
        { 0.7, 20, 60, 0.35, 0.65, 0.000000, 0.693957, 0.306043 },
        { 0.15, 0, 25, 0.2, 0.75, 0.683594, 0.316406, 0.000000 },
        { 0.9, 0, 0, 0.3, 0.7, 0.000000, 0.000000, 1.000000 },
        { 0.5, -40, 0, 0.2, 0.8, 0.000000, 1.000000, 0.000000 },
    };

    [Theory]
    [InlineData(0.5, 100, 0.25)]
    [InlineData(0.25, -100, 0.5)]
    [InlineData(0.4, 0, 0.4)]
    public void BalancedPivotsRoundTripThroughPlotSpace(double edge, double balance, double plot)
    {
        Assert.Equal(plot, MuiColorGradeZoneWeightsMath.PlotPosition(edge, balance), 9);
        Assert.Equal(edge, MuiColorGradeZoneWeightsMath.ValueAtPlotPosition(plot, balance), 9);
    }

    [Theory]
    [MemberData(nameof(Goldens))]
    public void StripWeightsMatchTheStage(
        double l, double balance, double blending, double shadowEdge, double highlightEdge,
        double wantShadow, double wantMid, double wantHighlight)
    {
        var (shadow, mid, highlight) = MuiColorGradeZoneWeightsMath.ComputeWeights(l, balance, blending, shadowEdge, highlightEdge);
        Assert.Equal(wantShadow, shadow, 4);
        Assert.Equal(wantMid, mid, 4);
        Assert.Equal(wantHighlight, highlight, 4);
    }

    [Theory]
    [InlineData(0.5601, 0.10, 0.564622, 0.564622)]
    [InlineData(0.9, 0.10, 0.564622, 0.564622)]
    [InlineData(0.5602, 0.564622, 0.90, 0.564622)]
    [InlineData(0.2514, 0.10, 0.564622, 0.25)]
    [InlineData(0.3125, 0.10, 0.564622, 0.31)]
    [InlineData(0.8125, 0.564622, 0.90, 0.81)]
    [InlineData(0.125, 0.10, 0.564622, 0.13)]
    [InlineData(0.625, 0.564622, 0.90, 0.63)]
    [InlineData(0.02, 0.10, 0.564622, 0.10)]
    [InlineData(0.95, 0.564622, 0.90, 0.90)]
    public void EdgeDragRoundsSnapsToTheAnchorAndClampsLikeTheOtherPlatforms(
        double norm, double min, double max, double want)
    {
        Assert.Equal(want, MuiColorGradeZoneWeightsMath.SnapEdge(norm, min, max), 9);
    }
}
