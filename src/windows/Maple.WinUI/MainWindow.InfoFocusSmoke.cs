using System;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading.Tasks;
using Maple.WinUI.Services.Xmp;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Input;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyInspectorFocusCheckpointsAsync(string raw, string output)
    {
        if (Array.IndexOf(Environment.GetCommandLineArgs(), "--inspector-focus-checkpoints") < 0) return;
        var photo = ViewModel.SelectedPhoto;
        var adjustments = ViewModel.Adjustments;
        var originalMode = _mode;
        if (originalMode != ShellMode.Edit)
            throw new InvalidOperationException("Info focus qualification must start in Edit mode.");
        var originalInfo = _infoPaneOpen;
        var original = Snapshot();
        var undo = ViewModel.UndoCount;
        var hash = await HashRawAsync();
        _infoPaneOpen = false;
        SetMode(ShellMode.Preview);
        UpdateInfoPane();
        ((FrameworkElement)Content).UpdateLayout();
        // The probe launches hidden. Establish native foreground activation
        // with real caption input before assigning its starting keyboard focus.
        await Checkpoint("activate", "pointer:window caption", () => _mode == ShellMode.Preview);
        if (!PreviewInfoButton.Focus(FocusState.Keyboard))
            throw new InvalidOperationException("Photo info cannot receive keyboard focus.");
        await Checkpoint("open", "Return", () => IsOpen() && KeyboardFocused(InfoCloseButton));
        await Checkpoint("tab-rating", "Tab", () => IsOpen() && Focused(_starButtons[0]));
        await Checkpoint("return-close", "Shift_L+Tab", () => IsOpen() && Focused(InfoCloseButton));
        await Checkpoint("close", "Return", () => IsClosed() && Focused(PreviewInfoButton));
        await Checkpoint("reopen", "Return", () => IsOpen() && Focused(InfoCloseButton));
        await Checkpoint("escape-inside", "Escape", () => IsClosed() && Focused(PreviewInfoButton));
        await Checkpoint("open-for-header", "Return", () => IsOpen() && Focused(InfoCloseButton));
        await Checkpoint("header-close", "pointer:Photo info", () => IsClosed() && Focused(PreviewInfoButton));
        await Checkpoint("keyboard-after-pointer-close", "Return", () => IsOpen() && KeyboardFocused(InfoCloseButton));
        await Checkpoint("space-close", "space", () => IsClosed() && KeyboardFocused(PreviewInfoButton));
        await Checkpoint("pointer-reopen", "pointer:Photo info", () => IsOpen() && Focused(InfoCloseButton));
        await Checkpoint("space-after-pointer-open", "space", () => IsClosed() && KeyboardFocused(PreviewInfoButton));
        await Checkpoint("escape-outside", "Escape", () => _mode == ShellMode.Browse && !_infoPaneOpen);
        var finalHash = await HashRawAsync();
        if (!hash.AsSpan().SequenceEqual(finalHash)) throw new InvalidOperationException("Info focus changed the RAW.");
        _infoPaneOpen = originalInfo;
        SetMode(originalMode);
        UpdateInfoPane();
        ((FrameworkElement)Content).UpdateLayout();
        if (!CompareButton.Focus(FocusState.Keyboard) || !Focused(CompareButton))
            throw new InvalidOperationException("Restored Edit mode has no visible Compare focus.");
        await File.WriteAllTextAsync(Path.Combine(output, "inspector-focus-result.json"), JsonSerializer.Serialize(new
        {
            // Caption activation is setup; the remaining checkpoints exercise 13 focus transitions.
            passed = true, casesExecuted = 13, casesSkipped = 0, originalRawSha256 = Convert.ToHexString(hash),
            documentPreserved = Snapshot() == original, undoDepth = undo, scale = Content.XamlRoot.RasterizationScale,
            restoredFocus = AutomationProperties.GetName(CompareButton)
        }));

        bool Focused(DependencyObject control) => ReferenceEquals(FocusManager.GetFocusedElement(Content.XamlRoot), control);
        bool KeyboardFocused(Microsoft.UI.Xaml.Controls.Control control) => Focused(control) && control.FocusState == FocusState.Keyboard;
        bool IsOpen() => _mode == ShellMode.Preview && _infoPaneOpen && InfoPane.Visibility == Visibility.Visible;
        bool IsClosed() => _mode == ShellMode.Preview && !_infoPaneOpen && InfoPane.Visibility == Visibility.Collapsed;
        string Snapshot() => XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = ViewModel.Adjustments });

        async Task<byte[]> HashRawAsync()
        {
            await using var stream = File.OpenRead(raw);
            return await SHA256.HashDataAsync(stream);
        }

        async Task Checkpoint(string name, string input, Func<bool> valid)
        {
            var path = Path.Combine(output, "inspector-focus-" + name);
            if (File.Exists(path + ".continue")) throw new InvalidOperationException("Fresh Info checkpoints required.");
            await File.WriteAllTextAsync(path + ".ready.tmp", JsonSerializer.Serialize(new
            {
                name, input, mode = _mode.ToString(), infoOpen = _infoPaneOpen,
                focus = FocusManager.GetFocusedElement(Content.XamlRoot) is DependencyObject focused
                    ? AutomationProperties.GetName(focused) : null
            }));
            File.Move(path + ".ready.tmp", path + ".ready", overwrite: true);
            var deadline = Environment.TickCount64 + 180000;
            while (!File.Exists(path + ".continue"))
            {
                if (Environment.TickCount64 >= deadline) throw new TimeoutException("Info input not acknowledged: " + name);
                await Task.Delay(50);
            }
            deadline = Environment.TickCount64 + 5000;
            while (!valid() && Environment.TickCount64 < deadline) await Task.Delay(25);
            if (!valid() || !ReferenceEquals(photo, ViewModel.SelectedPhoto)
                || !ReferenceEquals(adjustments, ViewModel.Adjustments) || Snapshot() != original || ViewModel.UndoCount != undo)
                throw new InvalidOperationException("Info focus/document checkpoint failed: " + name);
            RecordSmokeStage(output, "inspector-focus-" + name + "-passed");
        }
    }
}
