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
        var originalTint = ViewModel.Adjustments.Tint;
        var originalDepth = ViewModel.UndoCount;
        ViewModel.ApplyPreset(PresetDocument.Parse("""
            {"schemaVersion":1,"name":"Existing tint","fields":{"tint":22}}
            """));
        var before = ViewModel.Adjustments.Clone();
        var depth = ViewModel.UndoCount;
        var preset = PresetDocument.Parse("""
            {"schemaVersion":1,"name":"Sparse undo check","fields":{"contrast":-43,"saturation":-29,"tint":true,"future_setting":true}}
            """);
        var result = ViewModel.ApplyPreset(preset);
        if (result.Applied.Length != 2 || result.Skipped.Length != 2
            || ViewModel.Adjustments.Tint != 22
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
        var reset = ViewModel.ApplyPreset(preset, reset: true);
        if (ViewModel.Adjustments.Contrast != 0 || ViewModel.Adjustments.Saturation != 0
            || ViewModel.Adjustments.Tint != 22 || reset.Skipped.Length != 2
            || ViewModel.Adjustments.Exposure != before.Exposure || ViewModel.UndoCount != depth + 2)
            throw new InvalidOperationException("Preset reset was not a sparse, discrete edit.");
        ViewModel.Undo();
        if (ViewModel.Adjustments.Contrast != -43 || ViewModel.Adjustments.Saturation != -29)
            throw new InvalidOperationException("Preset reset Undo lost the applied values.");
        ViewModel.Redo();
        if (ViewModel.Adjustments.Contrast != 0 || ViewModel.Adjustments.Saturation != 0
            || ViewModel.Adjustments.Tint != 22 || ViewModel.UndoCount != depth + 2)
            throw new InvalidOperationException("Preset reset Redo changed a rejected field or undo depth.");
        ViewModel.Undo();
        ViewModel.Undo();
        ViewModel.Undo();
        if (ViewModel.Adjustments.Tint != originalTint || ViewModel.UndoCount != originalDepth)
            throw new InvalidOperationException($"Preset verification did not restore its initial state: "
                + $"tint={ViewModel.Adjustments.Tint}, expected={originalTint}, "
                + $"undo={ViewModel.UndoCount}, expected={originalDepth}.");
        VerifyWhiteBalanceSliderReset();
    }

    private void VerifyWhiteBalanceSliderReset()
    {
        var original = XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = ViewModel.Adjustments });
        var originalDepth = ViewModel.UndoCount;
        var defaults = ViewModel.DefaultAdjustments();
        foreach (var (label, field, target) in new[]
        {
            ("Temp", "temperature", defaults.Temperature),
            ("Tint", "tint", defaults.Tint)
        })
        {
            var slider = ViewModel.Sections.Single(section => section.Title == "Color").Sliders.Single(row => row.Label == label);
            if (slider.DefaultValue != target || slider.IsModified)
                throw new InvalidOperationException($"As-shot {label} is marked modified or has the wrong reset origin.");
            var changed = target + (label == "Temp" ? 500 : 17);
            var json = System.Text.Json.JsonSerializer.Serialize(new
            {
                schemaVersion = 1, name = "As-shot reset check",
                fields = new System.Collections.Generic.Dictionary<string, double> { [field] = changed }
            });
            ViewModel.ApplyPreset(PresetDocument.Parse(json));
            if (!slider.IsModified || slider.Value != changed)
                throw new InvalidOperationException($"Manual {label} is not marked modified.");
            slider.Reset();
            if (slider.Value != target || slider.IsModified)
                throw new InvalidOperationException($"{label} reset did not restore the photo's as-shot identity.");
            ViewModel.Undo();
            if (slider.Value != changed || !slider.IsModified)
                throw new InvalidOperationException($"{label} reset Undo did not restore the manual value.");
            ViewModel.Undo();
            if (ViewModel.UndoCount != originalDepth ||
                original != XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = ViewModel.Adjustments }))
                throw new InvalidOperationException($"{label} reset verification changed the initial document.");
        }
    }
}
