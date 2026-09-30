using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.UI;
using Maple.UI.Atoms;
using Maple.WinUI.Models;
using Maple.WinUI.Services;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private readonly PresetStore _presetStore = new();
    private readonly MuiPresetsPanel _presetsPanel = new();
    private readonly TextBlock _presetStatus = new() { TextWrapping = TextWrapping.Wrap, FontSize = 12 };
    private readonly MuiButton _resetPreset = new() { Label = "Reset applied preset fields", Variant = MuiButtonVariant.Ghost, IsEnabled = false };
    private Dictionary<string, PresetDocument> _presets = new(StringComparer.Ordinal);
    private PresetDocument? _lastAppliedPreset;
    private bool _presetBusy;

    private void BuildPresetsPanel()
    {
        AutomationProperties.SetLiveSetting(_presetStatus, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Polite);
        var retry = new MuiButton { Label = "Reload presets", Variant = MuiButtonVariant.Ghost };
        retry.Click += (_, _) => _ = RunPresetOperationAsync(() => ReloadPresetsAsync());
        _presetsPanel.PresetSaved += (_, name) => _ = RunPresetOperationAsync(async () =>
        {
            if (!ViewModel.AdjustmentsReady || ViewModel.SelectedPhoto == null) throw new InvalidOperationException("Wait for the photo's adjustments to load.");
            await _presetStore.CreateAsync(name, AdjustmentFieldBridge.Capture(ViewModel.Adjustments));
            await ReloadPresetsAsync($"Saved {name.Trim()}.");
        });
        _presetsPanel.PresetApplied += (_, id) => _ = RunPresetOperationAsync(() =>
        {
            var preset = _presets[id];
            var result = ViewModel.ApplyPreset(preset);
            _lastAppliedPreset = result.Applied.Length == 0 ? null : preset;
            _resetPreset.IsEnabled = _lastAppliedPreset != null;
            ShowPresetResult(preset, result, false);
            return Task.CompletedTask;
        });
        _presetsPanel.PresetDeleted += (_, id) => _ = RunPresetOperationAsync(async () =>
        {
            await _presetStore.DeleteAsync(id);
            await ReloadPresetsAsync("Preset deleted. The photo's adjustments were kept.");
        });
        _presetsPanel.PresetRenamed += (id, name) => _ = RunPresetOperationAsync(async () =>
        {
            await _presetStore.RenameAsync(id, name);
            await ReloadPresetsAsync($"Renamed to {name.Trim()}.");
        });
        _presetsPanel.ImportRequested += (_, _) => _ = RunPresetOperationAsync(ImportPresetAsync);
        _presetsPanel.PresetExported += (_, id) => _ = RunPresetOperationAsync(() => ExportPresetAsync(_presets[id]));
        _resetPreset.Click += (_, _) => _ = RunPresetOperationAsync(() =>
        {
            if (_lastAppliedPreset is { } preset) ShowPresetResult(preset, ViewModel.ApplyPreset(preset, reset: true), true);
            return Task.CompletedTask;
        });
        PanelPresetsHost.Children.Add(_presetStatus);
        PanelPresetsHost.Children.Add(retry);
        PanelPresetsHost.Children.Add(_resetPreset);
        PanelPresetsHost.Children.Add(_presetsPanel);
    }

    private void OnPresetTools(object sender, RoutedEventArgs e) => ToggleGroupPanel("Presets");

    private async Task RunPresetOperationAsync(Func<Task> operation)
    {
        if (_presetBusy || _closing) return;
        _presetBusy = true;
        _presetsPanel.IsEnabled = false;
        _resetPreset.IsEnabled = false;
        _presetStatus.Text = "Working…";
        try { await operation(); }
        catch (Exception error)
        {
            DiagLog.Write($"[presets] {error}");
            if (!_closing) _presetStatus.Text = error.Message;
        }
        finally
        {
            _presetBusy = false;
            if (!_closing)
            {
                _presetsPanel.IsEnabled = true;
                _resetPreset.IsEnabled = _lastAppliedPreset != null;
            }
        }
    }

    private async Task ReloadPresetsAsync(string? message = null)
    {
        var library = await _presetStore.LoadAsync();
        if (_closing) return;
        _presets = library.Presets.ToDictionary(p => p.Id, StringComparer.Ordinal);
        _presetsPanel.Presets = library.Presets.Select(p => new MuiPreset(p.Id, p.Name, DateTimeOffset.MinValue, p.BuiltIn)).ToArray();
        _presetStatus.Text = message ?? "Presets change only their named settings. Built-ins are read-only. User presets are stored on this device.";
        if (library.Errors.Count != 0) _presetStatus.Text += "\nSome presets could not be loaded:\n" + string.Join("\n", library.Errors);
    }

    private void ShowPresetResult(PresetDocument preset, SparseAdjustmentResult result, bool reset)
    {
        _presetStatus.Text = result.Applied.Length == 0 ? $"No supported settings in {preset.Name}."
            : $"{(reset ? "Reset" : "Applied")} {result.Applied.Length} settings from {preset.Name}. Undo restores the previous edit.";
        if (result.Skipped.Length != 0)
            _presetStatus.Text += "\nNot applied (unsupported, image-specific or invalid): " + string.Join(", ", result.Skipped) + ". These fields remain in the preset file.";
    }

    private async Task ImportPresetAsync()
    {
        var picker = new Windows.Storage.Pickers.FileOpenPicker();
        picker.FileTypeFilter.Add(".json");
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
        var file = await picker.PickSingleFileAsync();
        if (file == null) { _presetStatus.Text = "Import cancelled."; return; }
        var imported = await _presetStore.ImportAsync(file.Path);
        await ReloadPresetsAsync($"Imported {imported.Name}.");
    }

    private async Task ExportPresetAsync(PresetDocument preset)
    {
        var picker = new Windows.Storage.Pickers.FileSavePicker { SuggestedFileName = "maple-preset" };
        picker.FileTypeChoices.Add("Maple preset", new[] { ".json" });
        WinRT.Interop.InitializeWithWindow.Initialize(picker, WinRT.Interop.WindowNative.GetWindowHandle(this));
        var file = await picker.PickSaveFileAsync();
        if (file == null) { _presetStatus.Text = "Export cancelled."; return; }
        if (!string.Equals(Path.GetExtension(file.Path), ".json", StringComparison.OrdinalIgnoreCase))
            throw new IOException("Save presets with the .json extension.");
        var target = Path.GetFullPath(file.Path);
        if (ViewModel.ExportProtectedOriginals().Select(Path.GetFullPath).Contains(target, StringComparer.OrdinalIgnoreCase))
            throw new IOException("A preset cannot replace an original photo.");
        await PresetStore.ExportAsync(preset, target);
        _presetStatus.Text = $"Exported {preset.Name}.";
    }
}
