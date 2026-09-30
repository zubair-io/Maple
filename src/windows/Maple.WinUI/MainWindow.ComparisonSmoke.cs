using System;
using System.IO;
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
            Adjustments = new AdjustmentState { FilmLook = FilmCatalog.All[0].Id, FilmStrength = 65 }
        });
        try
        {
            ViewModel.SelectedPhoto = new PhotoItem
            {
                FilePath = path, FileName = Path.GetFileName(path), Format = "DNG"
            };
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
}
