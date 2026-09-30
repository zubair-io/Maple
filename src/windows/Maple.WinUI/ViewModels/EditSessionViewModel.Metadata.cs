using System;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    // #3878: a metadata dialog must wait for earlier autosaves before reading
    // its preview. Keep failures until observed; a logged error is not a save.
    private readonly PendingCloudSidecarWrites _cloudMetadataWrites = new();
    private readonly object _localMetadataGate = new();
    private readonly Services.Xmp.PendingLocalSidecarWrites _localMetadataWrites = new();
    private Exception? _localMetadataError;

    private void TrackCloudMetadataWrite(Func<Task> write) => _cloudMetadataWrites.Enqueue(write);

    private void OnCloudMetadataFailure(Exception error)
    {
        Services.DiagLog.Write($"[cloud] metadata save failed: {error.Message}");
        OnUi(() => CloudStatus = $"Sidecar sync failed: {error.Message}");
    }

    public async Task PrepareMetadataAsync()
    {
        if (_openPhoto?.IsCloud == true)
        {
            await _cloudSidecarLoad;
            if (_cloudSidecarLoadError != null)
                throw new InvalidOperationException("Opening cloud metadata failed: " + _cloudSidecarLoadError.Message);
        }
        _sidecarTimer?.Dispose();
        // The modal prevents edits while this runs. Flush the previous
        // adjustment snapshots before reading metadata; failed writes remain
        // queued by photo so navigation cannot silently discard those edits.
        await Task.Run(FlushSidecarNow);
        if (_localMetadataError != null)
            throw new InvalidOperationException("Pending adjustment save failed: " + _localMetadataError.Message);
        await _cloudMetadataWrites.DrainAsync(retryFailed: true);
    }
}
