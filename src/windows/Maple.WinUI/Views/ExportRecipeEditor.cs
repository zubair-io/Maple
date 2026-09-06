using System;
using System.Collections.Generic;
using System.Globalization;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.WinUI.Generated;

namespace Maple.WinUI.Views;

/// <summary>Edits the shared recipe without dropping imported, unsupported policy values.</summary>
public sealed class ExportRecipeEditor : StackPanel
{
    private ExportRecipe _recipe;
    private bool _loading, _formatEdited, _qualityEdited, _sizeEdited;
    private readonly TextBox _name = new() { Header = "Recipe name" };
    private readonly ComboBox _format = Choice("Format", "jpeg", "tiff", "png");
    private readonly ComboBox _depth = Choice("Bit depth", "8", "16");
    private readonly NumberBox _quality = new() { Header = "JPEG quality", Minimum = 1, Maximum = 100 };
    private readonly NumberBox _size = new() { Header = "Long edge (0 = full resolution)", Minimum = 0, Maximum = uint.MaxValue };
    private readonly ComboBox _profile = Choice("Output profile", "srgb", "display-p3");
    private readonly ComboBox _intent = Choice("Rendering intent", "maple-display");
    private readonly ComboBox _metadata = Choice("Metadata policy", "strip");
    private readonly TextBox _template = new() { Header = "Filename template", PlaceholderText = "{original}-{n}.{ext}" };
    private readonly TextBox _directory = new() { Header = "Destination", IsReadOnly = true };
    private readonly ComboBox _overwrite = Choice("When a destination file exists", "error", "skip", "replace");
    private readonly TextBlock _watermark = new() { TextWrapping = TextWrapping.Wrap };
    private readonly Button _clearWatermark = new() { Content = "Remove unsupported watermark" };
    public TextBlock Message { get; } = new() { TextWrapping = TextWrapping.Wrap };
    public Button FolderButton { get; } = new() { Content = "Choose destination folder…" };
    public Button SaveButton { get; } = new() { Content = "Save recipe" };
    public Button ImportButton { get; } = new() { Content = "Import recipe…" };
    public Button ExportButton { get; } = new() { Content = "Export recipe…" };
    public ComboBox SavedRecipes { get; } = new() { Header = "Saved recipes", HorizontalAlignment = HorizontalAlignment.Stretch };

    public ExportRecipeEditor(ExportRecipe recipe, IReadOnlyList<ExportRecipe> saved)
    {
        _recipe = recipe;
        Width = 420;
        Spacing = 10;
        Children.Add(SavedRecipes);
        Children.Add(_name);
        var recipeButtons = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        recipeButtons.Children.Add(SaveButton);
        recipeButtons.Children.Add(ImportButton);
        recipeButtons.Children.Add(ExportButton);
        Children.Add(recipeButtons);
        foreach (var control in new UIElement[] { _format, _depth, _quality, _size, _profile, _intent, _metadata,
            _template, _directory, FolderButton, _overwrite, _watermark, _clearWatermark, Message }) Children.Add(control);
        Children.Add(new TextBlock
        {
            Text = "Exports keep the output color profile and strip source metadata. JPEG is 8-bit, TIFF 16-bit, PNG 8-bit. Imported unsupported choices remain saved and are rejected before execution.",
            TextWrapping = TextWrapping.Wrap,
        });
        _format.SelectionChanged += (_, _) =>
        {
            _quality.IsEnabled = Selected(_format) == "jpeg";
            if (!_loading)
            {
                _formatEdited = true;
                if (Selected(_format) is "jpeg" or "tiff" or "png")
                    Select(_depth, Selected(_format) == "tiff" ? "16" : "8");
            }
        };
        _quality.ValueChanged += (_, _) => { if (!_loading) _qualityEdited = true; };
        _size.ValueChanged += (_, _) => { if (!_loading) _sizeEdited = true; };
        _clearWatermark.Click += (_, _) => { _recipe = _recipe with { Watermark = null }; ShowWatermark(); };
        SavedRecipes.SelectionChanged += (_, _) =>
        {
            if (SavedRecipes.SelectedItem is ComboBoxItem { Tag: ExportRecipe selected }) Load(selected);
        };
        SetSaved(saved);
        Load(recipe);
    }

    public void SetSaved(IReadOnlyList<ExportRecipe> recipes)
    {
        SavedRecipes.Items.Clear();
        foreach (var recipe in recipes) SavedRecipes.Items.Add(new ComboBoxItem { Content = recipe.Name, Tag = recipe });
    }

    public void Load(ExportRecipe recipe)
    {
        _loading = true;
        _recipe = recipe;
        _name.Text = recipe.Name;
        Select(_format, recipe.Format);
        Select(_depth, recipe.BitDepth.ToString(CultureInfo.InvariantCulture));
        _quality.Value = recipe.Quality ?? 92;
        _quality.IsEnabled = recipe.Format == "jpeg";
        _size.Value = recipe.MaxLongEdge ?? 0;
        Select(_profile, recipe.OutputProfile);
        Select(_intent, recipe.RenderingIntent);
        Select(_metadata, recipe.MetadataPolicy);
        _template.Text = recipe.NamingTemplate;
        _directory.Text = recipe.Directory ?? recipe.Destination;
        Select(_overwrite, recipe.OverwritePolicy);
        Message.Text = "";
        ShowWatermark();
        _formatEdited = _qualityEdited = _sizeEdited = false;
        _loading = false;
    }

    public void SetDirectory(string directory)
    {
        _recipe = _recipe with { Destination = "directory", Directory = directory };
        _directory.Text = directory;
        if (Selected(_overwrite) == "browser") Select(_overwrite, "error");
    }

    public ExportRecipe Read()
    {
        var format = Selected(_format);
        var known = format is "jpeg" or "tiff" or "png";
        if (!double.IsFinite(_size.Value) || _size.Value < 0 || _size.Value != Math.Truncate(_size.Value))
            throw new InvalidOperationException("Long edge must be a whole number, or 0 for full resolution.");
        if (format == "jpeg" && (!double.IsFinite(_quality.Value) || _quality.Value != Math.Truncate(_quality.Value)))
            throw new InvalidOperationException("JPEG quality must be a whole number from 1 to 100.");
        return _recipe with
        {
            Name = _name.Text, Format = format,
            BitDepth = uint.Parse(Selected(_depth), CultureInfo.InvariantCulture),
            Quality = _formatEdited && known ? (format == "jpeg" ? checked((uint)_quality.Value) : null)
                : _qualityEdited ? checked((uint)_quality.Value) : _recipe.Quality,
            MaxLongEdge = !_sizeEdited ? _recipe.MaxLongEdge : _size.Value == 0 ? null : checked((uint)_size.Value),
            OutputProfile = Selected(_profile), RenderingIntent = Selected(_intent),
            MetadataPolicy = Selected(_metadata), NamingTemplate = _template.Text,
            OverwritePolicy = Selected(_overwrite),
        };
    }

    private void ShowWatermark()
    {
        _watermark.Text = _recipe.Watermark == null ? "" : $"Imported watermark (unsupported): {_recipe.Watermark}";
        _clearWatermark.Visibility = _recipe.Watermark == null ? Visibility.Collapsed : Visibility.Visible;
    }

    private static ComboBox Choice(string title, params string[] values)
    {
        var combo = new ComboBox { Header = title, HorizontalAlignment = HorizontalAlignment.Stretch };
        foreach (var value in values) combo.Items.Add(value);
        return combo;
    }

    private static string Selected(ComboBox combo) => combo.SelectedItem as string ?? "";
    private static void Select(ComboBox combo, string value)
    {
        if (!combo.Items.Contains(value)) combo.Items.Add(value);
        combo.SelectedItem = value;
    }
}
