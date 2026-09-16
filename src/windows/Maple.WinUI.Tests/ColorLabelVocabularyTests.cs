using Maple.WinUI.Services.Xmp;
using Xunit;

namespace Maple.WinUI.Tests;

public class ColorLabelVocabularyTests
{
    [Fact]
    public void GeneratedVocabularyPreservesExistingOrderAndSpelling()
    {
        Assert.Equal(new[] { "red", "orange", "yellow", "green", "blue", "purple" }, XmpSchema.ColorLabels);
    }

    [Fact]
    public void EveryLabelRoundTripsThroughARealSidecar()
    {
        var directory = Path.Combine(Path.GetTempPath(), "maple-color-label-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            foreach (var label in XmpSchema.ColorLabels)
            {
                var rawPath = Path.Combine(directory, label + ".dng");
                SidecarStore.Save(rawPath, new XmpSidecarDocument { ColorLabel = label });
                Assert.Equal(label, SidecarStore.Load(rawPath)!.ColorLabel);
                Assert.Contains($"papp:ColorLabel=\"{label}\"", File.ReadAllText(SidecarStore.SidecarPathFor(rawPath)));
            }
            foreach (var invalid in new[] { "Red", "RED", "magenta", "" })
            {
                var rawPath = Path.Combine(directory, "invalid.dng");
                SidecarStore.Save(rawPath, new XmpSidecarDocument { ColorLabel = invalid });
                Assert.Null(SidecarStore.Load(rawPath)!.ColorLabel);
            }
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
