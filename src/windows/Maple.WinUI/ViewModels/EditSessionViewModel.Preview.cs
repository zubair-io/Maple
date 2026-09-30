using System;
using System.Threading;
using System.Threading.Tasks;
using CommunityToolkit.Mvvm.ComponentModel;
using Maple.WinUI.Services;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    [ObservableProperty] private bool _hasDecodeError;

    public void RetryPreview()
    {
        if (_disposed || IsDecoding) return;
        _decodedPhoto = null;
        EnsureDecoded();
    }

    /// <summary>Extract the cached embedded Preview; RAWs without one
    /// use the selected photo's bounded scene-linear preview decode.</summary>
    private void RequestEmbeddedPreview(PhotoItem photo)
    {
        if (photo.PreviewPath != null) return;
        var version = _photoOpenVersion;
        _ = Task.Run(async () =>
        {
            string? path = null;
            try
            {
                path = await _thumbnails.GetOrCreateAsync(
                    photo.FilePath, CancellationToken.None, ThumbnailService.PreviewMaxPx);
            }
            catch (Exception error) { DiagLog.Write($"[preview] {error.Message}"); }
            OnUi(() =>
            {
                if (_disposed || version != _photoOpenVersion || !ReferenceEquals(photo, SelectedPhoto)) return;
                if (path != null) photo.PreviewPath = new Uri(path).AbsoluteUri;
                else EnsureDecoded();
            });
        });
    }
}
