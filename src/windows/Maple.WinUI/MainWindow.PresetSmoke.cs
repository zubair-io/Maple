using System;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyPresetUndoAsync()
    {
        var before = ViewModel.Adjustments.Clone();
        var depth = ViewModel.UndoCount;
        var preset = PresetDocument.Parse("""
            {"schemaVersion":1,"name":"Sparse undo check","fields":{"contrast":-43,"saturation":-29,"future_setting":true}}
            """);
        var result = ViewModel.ApplyPreset(preset);
        if (result.Applied.Length != 2 || result.Skipped.Length != 1
            || ViewModel.Adjustments.Contrast != -43 || ViewModel.Adjustments.Saturation != -29
            || ViewModel.Adjustments.Exposure != before.Exposure || ViewModel.UndoCount != depth + 1)
            throw new InvalidOperationException("Sparse preset did not create exactly one complete edit.");
        ViewModel.Undo();
        await Task.Delay(550);
        if (ViewModel.Adjustments.Contrast != before.Contrast
            || ViewModel.Adjustments.Saturation != before.Saturation || ViewModel.UndoCount != depth)
            throw new InvalidOperationException("Preset Undo did not restore the preceding state.");
        ViewModel.Redo();
        if (ViewModel.Adjustments.Contrast != -43 || ViewModel.Adjustments.Saturation != -29)
            throw new InvalidOperationException("Preset Redo did not restore both fields.");
        var export = (await ViewModel.CaptureExportInputsAsync()).Single();
        var snapshot = XmpParser.Parse(export.Xmp)
            ?? throw new InvalidOperationException("Preset export snapshot was not readable XMP.");
        if (snapshot.Adjustments.Contrast != -43 || snapshot.Adjustments.Saturation != -29
            || snapshot.Adjustments.Exposure != before.Exposure)
            throw new InvalidOperationException("Preset export snapshot lost sparse applied values.");
        var deadline = Environment.TickCount64 + 5000;
        XmpSidecarDocument? persisted;
        do
        {
            await Task.Delay(50);
            persisted = SidecarStore.Load(export.SourcePath);
        } while ((persisted?.Adjustments.Contrast != -43 || persisted?.Adjustments.Saturation != -29)
            && Environment.TickCount64 < deadline);
        if (persisted?.Adjustments.Contrast != -43 || persisted.Adjustments.Saturation != -29
            || persisted.Adjustments.Exposure != before.Exposure)
            throw new InvalidOperationException("Preset autosave did not persist sparse values to the real sidecar.");
        ViewModel.ApplyPreset(preset, reset: true);
        if (ViewModel.Adjustments.Contrast != 0 || ViewModel.Adjustments.Saturation != 0
            || ViewModel.Adjustments.Exposure != before.Exposure || ViewModel.UndoCount != depth + 2)
            throw new InvalidOperationException("Preset reset was not a sparse, discrete edit.");
        ViewModel.Undo();
        if (ViewModel.Adjustments.Contrast != -43 || ViewModel.Adjustments.Saturation != -29)
            throw new InvalidOperationException("Preset reset Undo lost the applied values.");
        ViewModel.Undo();
    }
}
