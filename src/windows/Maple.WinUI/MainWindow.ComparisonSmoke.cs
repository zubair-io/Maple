using System;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyFilmComparisonAsync(string raw, string output)
    {
        var previous = ViewModel.SelectedPhoto;
        var path = Path.Combine(output, "comparison-film.dng");
        File.Copy(raw, path);
        SidecarStore.Save(path, new XmpSidecarDocument
        {
            Adjustments = new AdjustmentState
            {
                FilmLook = FilmCatalog.All[0].Id, FilmStrength = 65,
                Temperature = 7000, Tint = 23
            }
        });
        try
        {
            ViewModel.SelectedPhoto = new PhotoItem
            {
                FilePath = path, FileName = Path.GetFileName(path), Format = "DNG"
            };
            if (ViewModel.DefaultAdjustments().Temperature != 6500 || ViewModel.DefaultAdjustments().Tint != 0)
                throw new InvalidOperationException("New photo inherited the previous photo's white-balance defaults.");
            // Establish the live calibrated model before taking the immutable
            // comparison snapshot; as-shot metadata arrives on initial decode.
            ViewModel.EnsureDecoded();
            var readyDeadline = Environment.TickCount64 + 90000;
            while ((ViewModel.IsDecoding || ViewModel.Renderer.DetailSource == null)
                && Environment.TickCount64 < readyDeadline) await Task.Delay(20);
            if (ViewModel.IsDecoding || ViewModel.Renderer.DetailSource == null)
                throw new InvalidOperationException("Film comparison source did not finish its initial decode.");
            RecordSmokeStage(output, "film-comparison-ready");
            VerifyCustomizedWhiteBalance();
            if (ViewModel.OpeningSnapshot().FilmLook != FilmCatalog.All[0].Id)
                throw new InvalidOperationException("Film comparison fixture did not load its opening look");
            await VerifyComparisonAsync(path);
            // Cancel an in-flight preparation by navigating away, then await
            // its actual task to prove a late frame cannot repopulate the UI.
            var pending = PrepareComparisonAsync();
            ViewModel.SelectedPhoto = previous;
            await pending;
            if (ComparisonImage.Source != null || _compareLoading)
                throw new InvalidOperationException("Superseded film comparison remained visible or loading");
        }
        finally
        {
            ViewModel.SelectedPhoto = previous;
            ResetComparison();
            ViewModel.EnsureDecoded();
            var deadline = Environment.TickCount64 + 90000;
            while ((ViewModel.IsDecoding || ViewModel.Renderer.DetailSource == null)
                && Environment.TickCount64 < deadline) await Task.Delay(20);
            if (ViewModel.IsDecoding || ViewModel.Renderer.DetailSource == null)
                throw new InvalidOperationException("Previous photo did not recover after film comparison");
        }
    }

    private void VerifyCustomizedWhiteBalance()
    {
        var initial = XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = ViewModel.Adjustments });
        var depth = ViewModel.UndoCount;
        var defaults = ViewModel.DefaultAdjustments();
        var color = ViewModel.Sections.Single(section => section.Title == "Color");
        foreach (var (label, target, value) in new[]
        {
            ("Temp", defaults.Temperature, 7000d), ("Tint", defaults.Tint, 23d)
        })
        {
            var row = color.Sliders.Single(slider => slider.Label == label);
            if (row.DefaultValue != target || row.Value != value || row.IsModified != (value != target))
                throw new InvalidOperationException($"Customized {label} was lost or its as-shot reset target is stale.");
        }
        ViewModel.ResetToDefaults();
        if (ViewModel.Adjustments.Temperature != defaults.Temperature || ViewModel.Adjustments.Tint != defaults.Tint
            || color.Sliders.Any(row => row.IsModified))
            throw new InvalidOperationException("Reset All did not restore photo-aware white-balance defaults.");
        ViewModel.Undo();
        if (ViewModel.UndoCount != depth || initial != XmpWriter.Serialize(new XmpSidecarDocument { Adjustments = ViewModel.Adjustments }))
            throw new InvalidOperationException("Reset All Undo did not restore customized white balance and the complete document.");
    }
}
