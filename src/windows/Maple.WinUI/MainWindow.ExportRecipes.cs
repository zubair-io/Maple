using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.WinUI.Generated;
using Maple.WinUI.Services.Export;
using Maple.WinUI.Views;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private ExportQueueStore? _exportStore;
    private ExportQueueRunner? _exportRunner;

    private void EnsureExportQueue()
    {
        if (_exportStore != null) return;
        _exportStore = new ExportQueueStore(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Maple", "exports"));
        _exportRunner = new ExportQueueRunner(_exportStore, new NativeExportRecipeExecutor());
    }

    private async void OnExportPhotos(object sender, RoutedEventArgs e) =>
        await RunModalFlowGuardedAsync(async () =>
        {
            try { EnsureExportQueue(); await ShowExportRecipeAsync(); }
            catch (Exception error) { await ShowMessageAsync("Export", error.Message); }
        });

    private static ExportRecipe DefaultWindowsRecipe() => new()
    {
        SchemaVersion = 1, Name = "JPEG sharing", Format = "jpeg", Quality = 92, BitDepth = 8,
        MaxLongEdge = null, OutputProfile = "srgb", RenderingIntent = "maple-display", MetadataPolicy = "strip",
        NamingTemplate = "{original}-{n}.{ext}", Destination = "directory", Directory = "",
        Watermark = null, OverwritePolicy = "error",
    };

    private async Task ShowExportRecipeAsync()
    {
        var saved = await Task.Run(() => _exportStore!.Recipes());
        var editor = new ExportRecipeEditor(saved.FirstOrDefault() ?? DefaultWindowsRecipe(), saved);
        var editorHost = new ContentControl { Content = editor };
        var dialog = new ContentDialog
        {
            Title = "Export photos", Content = new ScrollViewer { Content = editorHost, MaxHeight = 540 },
            PrimaryButtonText = "Add to queue", SecondaryButtonText = "Queue…", CloseButtonText = "Close",
            XamlRoot = (Content as FrameworkElement)?.XamlRoot,
        };
        ExportQueueJob? created = null;
        CancellationTokenSource? preparing = null;
        var busy = false;
        void SetBusy(bool value)
        {
            busy = value;
            editorHost.IsEnabled = !value;
            dialog.IsPrimaryButtonEnabled = !value;
            dialog.IsSecondaryButtonEnabled = !value;
        }
        dialog.Closing += (_, args) =>
        {
            if (!busy) return;
            args.Cancel = true;
            preparing?.Cancel();
            editor.Message.Text = "Cancelling export preparation…";
        };
        editor.FolderButton.Click += async (_, _) =>
        {
            try
            {
                var picker = new Windows.Storage.Pickers.FolderPicker();
                picker.FileTypeFilter.Add("*");
                WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
                var folder = await picker.PickSingleFolderAsync();
                if (folder != null) editor.SetDirectory(folder.Path);
            }
            catch (Exception error) { editor.Message.Text = error.Message; }
        };
        editor.SaveButton.Click += async (_, _) =>
        {
            try
            {
                var recipe = editor.Read();
                if (string.IsNullOrWhiteSpace(recipe.Name)) throw new InvalidOperationException("Give the recipe a name.");
                SetBusy(true);
                await Task.Run(() => _exportStore!.SaveRecipe(recipe));
                editor.SetSaved(await Task.Run(() => _exportStore!.Recipes()));
                editor.Message.Text = "Recipe saved. Imported unsupported choices are retained.";
            }
            catch (Exception error) { editor.Message.Text = error.Message; }
            finally { SetBusy(false); }
        };
        editor.ImportButton.Click += async (_, _) =>
        {
            try
            {
                var recipe = await ImportExportRecipeAsync();
                if (recipe != null) editor.Load(recipe);
            }
            catch (Exception error) { editor.Message.Text = error.Message; }
        };
        editor.ExportButton.Click += async (_, _) =>
        {
            try { await SaveExportRecipeFileAsync(editor.Read()); }
            catch (Exception error) { editor.Message.Text = error.Message; }
        };
        dialog.PrimaryButtonClick += async (_, args) =>
        {
            args.Cancel = true;
            var deferral = args.GetDeferral();
            try
            {
                var recipe = editor.Read();
                SetBusy(true);
                preparing = new CancellationTokenSource();
                editor.Message.Text = "Capturing edits and checking originals…";
                await Task.Run(() => _exportRunner!.ValidateRecipe(recipe));
                // Capture the model and selection before handing work to a background thread.
                var originals = ViewModel.ExportProtectedOriginals();
                var inputs = await ViewModel.CaptureExportInputsAsync(preparing!.Token);
                preparing.Token.ThrowIfCancellationRequested();
                created = await Task.Run(() => _exportRunner!.Create(recipe, inputs, originals, preparing.Token));
                args.Cancel = false;
            }
            catch (Exception error) { editor.Message.Text = error.Message; }
            finally { preparing?.Dispose(); preparing = null; SetBusy(false); deferral.Complete(); }
        };
        var result = await dialog.ShowAsync();
        if (created != null || result == ContentDialogResult.Secondary)
            await ShowExportQueueAsync(created?.Id);
    }

    private async Task<ExportRecipe?> ImportExportRecipeAsync()
    {
        var picker = new Windows.Storage.Pickers.FileOpenPicker();
        picker.FileTypeFilter.Add(".json");
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
        var file = await picker.PickSingleFileAsync();
        if (file == null) return null;
        var json = await File.ReadAllTextAsync(file.Path);
        return JsonSerializer.Deserialize<ExportRecipe>(json, ExportQueueStore.Json)
            ?? throw new InvalidDataException("Recipe JSON is empty.");
    }

    private async Task SaveExportRecipeFileAsync(ExportRecipe recipe)
    {
        var picker = new Windows.Storage.Pickers.FileSavePicker { SuggestedFileName = "maple-export-recipe" };
        picker.FileTypeChoices.Add("Export recipe", new[] { ".json" });
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
        var file = await picker.PickSaveFileAsync();
        if (file == null) return;
        if (!string.Equals(Path.GetExtension(file.Path), ".json", StringComparison.OrdinalIgnoreCase))
            throw new IOException("Save recipes with the .json extension.");
        var originals = ViewModel.ExportProtectedOriginals();
        await Task.Run(() =>
        {
            var target = ExportPaths.FilePath(file.Path);
            if (originals.Where(File.Exists).Select(ExportPaths.FilePath).Contains(target, StringComparer.OrdinalIgnoreCase))
                throw new IOException("A recipe cannot replace an original photo.");
            File.WriteAllText(file.Path, JsonSerializer.Serialize(recipe, ExportQueueStore.Json));
        });
    }
}
