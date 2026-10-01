using System;
using System.Threading.Tasks;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;
using Microsoft.UI.Xaml;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyGroupResetUndoAsync()
    {
        var original = Snapshot();
        var depth = ViewModel.UndoCount;
        var cases = new (string Group, string? Tab, Action<AdjustmentState> Edit, Func<AdjustmentState, bool> Reset)[]
        {
            ("Light", null, m => { m.Exposure = .8; m.Contrast = 24; }, m => m.Exposure == 0 && m.Contrast == 0),
            ("Detail", null, m => { m.CaptureSharpeningAmount = 20; m.CaptureSharpeningSigma = 1.4; m.Demosaic = "Rcd"; },
                m => m.CaptureSharpeningAmount == 0 && m.CaptureSharpeningSigma == 1 && m.Demosaic == "Auto"),
            ("Color", "HSL", m => { m.HueAdjustmentRed = 30; m.SaturationAdjustmentBlue = 20; },
                m => m.HueAdjustmentRed == 0 && m.SaturationAdjustmentBlue == 0),
            ("Color", "B&W", m => { m.BlackWhite = ToggleMode.On; m.GrayMixerRed = 20; },
                m => m.BlackWhite == ToggleMode.Off && m.GrayMixerRed == 0),
            ("Effects", "Grade", m => { m.ColorGradeGlobalHue = 50; m.ColorGradeGlobalSaturation = 20; m.SplitToneBalance = 25; },
                m => m.ColorGradeGlobalHue == 0 && m.ColorGradeGlobalSaturation == 0 && m.SplitToneBalance == 0),
            ("Tone Curve", null, m => { m.ToneCurveLuma.Add(new CurvePoint(.4, .6)); m.ParametricHighlights = 20; },
                m => m.ToneCurveLuma.Count == 0 && m.ParametricHighlights == 0),
        };
        foreach (var (group, tab, edit, reset) in cases)
        {
            ViewModel.ApplyDecodeFieldEdit(edit);
            await ReadyAsync();
            var edited = Snapshot();
            if (_activeGroup != group) ToggleGroupPanel(group);
            if (group == "Color") ShowColorTab(tab!);
            if (group == "Effects") ShowEffectsTab(tab!);
            OnResetGroup(GroupResetButton, new RoutedEventArgs());
            await ReadyAsync();
            if (!reset(ViewModel.Adjustments) || ViewModel.UndoCount != depth + 2)
                throw new InvalidOperationException($"{group}/{tab} Reset did not create one complete undo entry.");
            ViewModel.Undo();
            await ReadyAsync();
            if (Snapshot() != edited) throw new InvalidOperationException($"{group}/{tab} Reset Undo lost fields.");
            ViewModel.Redo();
            await ReadyAsync();
            if (!reset(ViewModel.Adjustments)) throw new InvalidOperationException($"{group}/{tab} Reset Redo failed.");
            ViewModel.Undo();
            await ReadyAsync();
            ViewModel.Undo();
            await ReadyAsync();
            if (Snapshot() != original || ViewModel.UndoCount != depth)
                throw new InvalidOperationException("Group reset verification changed the original document.");
        }
        var caBefore = ViewModel.AutoLateralCaOn;
        ViewModel.AutoLateralCaOn = !caBefore;
        if (!ViewModel.IsDecoding || ViewModel.UndoCount != depth + 1)
            throw new InvalidOperationException("Lateral CA did not start a decode with one undo entry.");
        await ReadyAsync();
        ViewModel.Undo();
        if (!ViewModel.IsDecoding || ViewModel.AutoLateralCaOn != caBefore)
            throw new InvalidOperationException("Lateral CA Undo did not restore and re-decode the source.");
        await ReadyAsync();
        if (Snapshot() != original || ViewModel.UndoCount != depth)
            throw new InvalidOperationException("Lateral CA verification changed the original document.");
        CloseGroupPanel();
        _colorTab = _effectsTab = "Basic";

        string Snapshot() => XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = ViewModel.Adjustments });
        async Task ReadyAsync()
        {
            var deadline = DateTime.UtcNow.AddSeconds(30);
            while (!ViewModel.AdjustmentsReady || ViewModel.IsDecoding)
            {
                if (DateTime.UtcNow >= deadline) throw new TimeoutException("Group reset decode did not settle.");
                await Task.Delay(25);
            }
        }
    }
}
