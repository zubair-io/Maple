using System;
using System.IO;
using System.Threading.Tasks;
using Maple.WinUI.Services.Xmp;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private async Task VerifyLocalSaveFailureAsync()
    {
        var photo = ViewModel.SelectedPhoto ?? throw new InvalidOperationException("Missing metadata photo");
        await ViewModel.PrepareMetadataAsync();
        var sidecar = SidecarStore.SidecarPathFor(photo.FilePath);
        if (!File.Exists(sidecar)) SidecarStore.Save(photo.FilePath, new());
        var before = File.ReadAllBytes(sidecar);
        var original = File.ReadAllBytes(photo.FilePath);
        var rating = photo.Rating;
        var changed = rating == 4 ? 3 : 4;
        try
        {
            using (var held = new FileStream(sidecar, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                ViewModel.SetRating(changed);
                await ViewModel.RetryLocalSaveAsync();
                await Task.Delay(100);
                Content.UpdateLayout();
                if (!ViewModel.HasLocalSaveError || !LocalSaveErrorBar.IsOpen ||
                    !ViewModel.LocalSaveError.Contains(photo.FileName))
                    throw new InvalidOperationException("Local save failure was not displayed with the affected photo");
                if (!before.AsSpan().SequenceEqual(File.ReadAllBytes(sidecar)))
                    throw new InvalidOperationException("Failed save changed the existing sidecar");
            }
            // Invoke the same handler as the visible Retry action.
            OnRetryLocalSave(LocalSaveRetry, new Microsoft.UI.Xaml.RoutedEventArgs());
            var deadline = Environment.TickCount64 + 5000;
            while (!LocalSaveRetry.IsEnabled && Environment.TickCount64 < deadline) await Task.Delay(20);
            await Task.Delay(100);
            if (ViewModel.HasLocalSaveError || LocalSaveErrorBar.IsOpen ||
                SidecarStore.Load(photo.FilePath)?.Rating != changed)
                throw new InvalidOperationException("Retry did not save the rating and clear its failure message");
            if (!original.AsSpan().SequenceEqual(File.ReadAllBytes(photo.FilePath)))
                throw new InvalidOperationException("Metadata save changed the original image");
        }
        finally
        {
            ViewModel.SetRating(rating);
            await ViewModel.PrepareMetadataAsync();
        }
    }
}
