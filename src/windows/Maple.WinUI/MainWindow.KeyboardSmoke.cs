using System;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.Tasks;
using Maple.UI.Atoms;
using Maple.WinUI.Services.Xmp;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Media;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyKeyboardCheckpointsAsync(string raw, string output)
    {
        if (Array.IndexOf(Environment.GetCommandLineArgs(), "--keyboard-checkpoints") < 0) return;
        var photo = ViewModel.SelectedPhoto;
        var originalGroup = _activeGroup;
        var originalHash = await HashRawAsync();
        var original = Snapshot();
        var exposure = ViewModel.Adjustments.Exposure;
        var depth = ViewModel.UndoCount;
        if (_activeGroup != "Light") ToggleGroupPanel("Light");
        ((FrameworkElement)Content).UpdateLayout();
        var slider = FindExposure(PanelSliders)
            ?? throw new InvalidOperationException("Keyboard check has no production Exposure slider.");
        if (!slider.Focus(FocusState.Keyboard))
            throw new InvalidOperationException("Production Exposure slider cannot receive keyboard focus.");
        var changed = exposure + slider.SmallChange;
        await CheckpointAsync("exposure-right", "Right", () =>
            Math.Abs(ViewModel.Adjustments.Exposure - changed) < 1e-9
            && Math.Abs(slider.Value - changed) < 1e-9 && ViewModel.UndoCount == depth + 1);
        var edited = Snapshot();
        await CheckpointAsync("exposure-undo", "Control_L+z", () => Snapshot() == original && ViewModel.UndoCount == depth);
        await CheckpointAsync("exposure-redo", "Control_L+Shift_L+z", () => Snapshot() == edited && ViewModel.UndoCount == depth + 1);
        await CheckpointAsync("exposure-restore", "Control_L+z", () => Snapshot() == original && ViewModel.UndoCount == depth);
        if (!CompareButton.Focus(FocusState.Keyboard))
            throw new InvalidOperationException("Header comparison action cannot receive keyboard focus.");
        await CheckpointAsync("editor-to-preview", "Escape", () => _mode == ShellMode.Preview && Snapshot() == original);
        await CheckpointAsync("preview-to-editor", "e", () => _mode == ShellMode.Edit && Snapshot() == original);
        var finalHash = await HashRawAsync();
        if (!originalHash.AsSpan().SequenceEqual(finalHash))
            throw new InvalidOperationException("Keyboard editing changed the original RAW.");
        CloseGroupPanel();
        if (originalGroup != null) ToggleGroupPanel(originalGroup);
        await File.WriteAllTextAsync(Path.Combine(output, "keyboard-result.json"), JsonSerializer.Serialize(new
        {
            passed = true, casesExecuted = 6, casesSkipped = 0,
            originalRawSha256 = Convert.ToHexString(originalHash),
            initialExposure = exposure, changedExposure = changed, initialUndoDepth = depth,
            finalUndoDepth = ViewModel.UndoCount, documentRestored = Snapshot() == original,
            scale = Content.XamlRoot.RasterizationScale
        }));

        string Snapshot() => XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = ViewModel.Adjustments });

        static MuiAdjustmentSlider? FindExposure(DependencyObject root)
        {
            if (root is MuiAdjustmentSlider candidate && AutomationProperties.GetName(candidate) == "Exposure")
                return candidate;
            for (var i = 0; i < VisualTreeHelper.GetChildrenCount(root); i++)
                if (FindExposure(VisualTreeHelper.GetChild(root, i)) is { } found) return found;
            return null;
        }

        async Task<byte[]> HashRawAsync()
        {
            await using var stream = File.OpenRead(raw);
            return await SHA256.HashDataAsync(stream);
        }

        async Task CheckpointAsync(string name, string key, Func<bool> valid)
        {
            var path = Path.Combine(output, "keyboard-" + name);
            if (File.Exists(path + ".continue"))
                throw new InvalidOperationException("Keyboard qualification requires fresh checkpoints.");
            await File.WriteAllTextAsync(path + ".ready.tmp", JsonSerializer.Serialize(new
            {
                name, key, exposure = ViewModel.Adjustments.Exposure, undoDepth = ViewModel.UndoCount,
                mode = _mode.ToString(), scale = Content.XamlRoot.RasterizationScale
            }));
            File.Move(path + ".ready.tmp", path + ".ready");
            var deadline = Environment.TickCount64 + 180000;
            while (!File.Exists(path + ".continue"))
            {
                if (Environment.TickCount64 >= deadline) throw new TimeoutException("Keyboard input not acknowledged: " + name);
                await Task.Delay(50);
            }
            deadline = Environment.TickCount64 + 5000;
            while (!valid() && Environment.TickCount64 < deadline) await Task.Delay(25);
            if (!valid() || !ReferenceEquals(photo, ViewModel.SelectedPhoto))
                throw new InvalidOperationException($"Keyboard action {name} did not preserve its expected document/history/photo: "
                    + $"exposure={ViewModel.Adjustments.Exposure}, undo={ViewModel.UndoCount}, mode={_mode}.");
            RecordSmokeStage(output, "keyboard-" + name + "-passed");
        }
    }
}
