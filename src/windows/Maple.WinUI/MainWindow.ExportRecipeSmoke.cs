using System;
using System.Linq;
using Maple.WinUI.Views;
using Microsoft.UI.Xaml.Controls;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private static void VerifyExportRecipeEditor()
    {
        var original = DefaultWindowsRecipe();
        var editor = new ExportRecipeEditor(original, new[] { original });
        if (editor.Read() != original)
            throw new InvalidOperationException("Opening the export editor changed the recipe.");

        ComboBox Field(string header) => editor.Children.OfType<ComboBox>()
            .Single(combo => Equals(combo.Header, header));
        void Choose(string header, string label)
        {
            var field = Field(header);
            field.SelectedItem = field.Items.OfType<ComboBoxItem>()
                .Single(item => Equals(item.Content, label));
        }

        Choose("Format", "TIFF");
        Choose("Output profile", "Display P3");
        Choose("When a destination file exists", "Skip existing files");
        var tiff = editor.Read();
        if (tiff.Format != "tiff" || tiff.BitDepth != 16 || tiff.Quality != null
            || tiff.OutputProfile != "display-p3" || tiff.OverwritePolicy != "skip"
            || tiff.RenderingIntent != "maple-display" || tiff.MetadataPolicy != "strip")
            throw new InvalidOperationException("Export labels changed stored recipe semantics.");
        Choose("Format", "JPEG");
        var jpeg = editor.Read();
        if (jpeg.BitDepth != 8 || jpeg.Quality != 92)
            throw new InvalidOperationException("Returning to JPEG did not restore valid encoding options.");

        var imported = original with
        {
            Format = "future-format", BitDepth = 32, OutputProfile = "future-profile",
            RenderingIntent = "future-intent", MetadataPolicy = "future-metadata",
            OverwritePolicy = "future-conflict", Quality = null, MaxLongEdge = 2048,
        };
        editor.Load(imported);
        editor.Load(imported);
        if (editor.Read() != imported
            || Field("Format").Items.OfType<ComboBoxItem>().Count(item => Equals(item.Tag, "future-format")) != 1)
            throw new InvalidOperationException("Loading an imported recipe lost or duplicated unknown choices.");
        Choose("Format", "PNG");
        var png = editor.Read();
        if (png.Format != "png" || png.BitDepth != 8 || png.Quality != null
            || png.OutputProfile != imported.OutputProfile || png.MetadataPolicy != imported.MetadataPolicy)
            throw new InvalidOperationException("Changing format discarded unrelated imported recipe policies.");
        editor.Load(original);
        if (editor.Read() != original)
            throw new InvalidOperationException("Reloading a saved recipe retained stale export choices.");
    }
}
