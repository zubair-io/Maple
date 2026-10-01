using Maple.WinUI.Services;
using Xunit;

namespace Maple.WinUI.Tests;

public sealed class PreviewDownsampleTests
{
    [Theory]
    [InlineData(3, 3)]
    [InlineData(4, 3)]
    [InlineData(3, 4)]
    [InlineData(1, 3)]
    [InlineData(3, 1)]
    [InlineData(1, 1)]
    public void Fast_preview_retains_the_last_row_and_column(int width, int height)
    {
        var pixels = new float[width * height * 4];
        for (var y = 0; y < height; y++)
            for (var x = 0; x < width; x++)
            {
                var i = (y * width + x) * 4;
                pixels[i] = x == width - 1 ? 1 : 0;
                pixels[i + 1] = y == height - 1 ? 1 : 0;
                pixels[i + 3] = 1;
            }
        var result = RenderEngine.DownsampleHalf(Image(width, height, pixels));
        Assert.Equal((width + 1) / 2, result.Width);
        Assert.Equal((height + 1) / 2, result.Height);
        Assert.Contains(result.Pixels.Where((_, i) => i % 4 == 0), value => value > 0);
        Assert.Contains(result.Pixels.Where((_, i) => i % 4 == 1), value => value > 0);
        Assert.All(result.Pixels.Where((_, i) => i % 4 == 3), value => Assert.Equal(1, value));
    }

    [Fact]
    public void Even_dimensions_keep_the_existing_quad_average()
    {
        var pixels = Enumerable.Range(0, 4 * 2 * 4).Select(i => (float)i).ToArray();
        var result = RenderEngine.DownsampleHalf(Image(4, 2, pixels));
        Assert.Equal(2, result.Width);
        Assert.Equal(1, result.Height);
        Assert.Equal(new float[] { 10, 11, 12, 13, 18, 19, 20, 21 }, result.Pixels);
    }

    [Theory]
    [InlineData(8, 4, 0.5f, 0.25f, 0.125f)]
    [InlineData(3, 5, 0.5f, 0.3f, 0.2f)]
    [InlineData(5, 1, 0.5f, 0.3f, 0.2f)]
    [InlineData(1, 1, 0.5f, 0.5f, 0.5f)]
    public void Fast_preview_composes_noise_sampling_density(
        int width, int height, float initial, float first, float second)
    {
        var source = Image(width, height, new float[width * height * 4], initial);
        var reduced = RenderEngine.DownsampleHalf(source);
        Assert.Equal(first, reduced.NrSamplingScale, 6);
        Assert.Equal(second, RenderEngine.DownsampleHalf(reduced).NrSamplingScale, 6);
        Assert.Equal(initial, source.NrSamplingScale);
    }

    private static DecodedImage Image(int width, int height, float[] pixels, float sampling = 1) => new()
    {
        Width = width, Height = height, Pixels = pixels,
        NoiseProfile = [], Iso = 100, AeGain = 1, WhitesAnchorEv = 0, NrSamplingScale = sampling,
        DecodedTemperature = 6500, DecodedTint = 0, WbFrame = [],
    };
}
