using System;
using System.Threading.Tasks;
using Maple.WinUI.Services;

namespace Maple.WinUI.ViewModels;

public partial class EditSessionViewModel
{
    private readonly Services.Cloud.CloudClientSlot _cloudSlot = new();
    private int _openCloudGeneration = -1;

    private Services.Cloud.CloudClient? _cloud
    {
        get => _cloudSlot.Current;
        set => _cloudSlot.Adopt(value);
    }

    private async Task<string?> ReleaseCloudSessionAsync()
    {
        try
        {
            do await PrepareCloseAsync();
            while (_sidecarDirty);
        }
        catch (Exception ex)
        {
            DiagLog.Write($"[cloud] pending saves failed while switching servers: {ex.Message}");
            var message = $"Pending changes could not be saved to the current server: {ex.Message}";
            CloudStatus = message;
            return message;
        }
        if (_selectedCloudFolder == null && !_isCloudTimeline && _openPhoto?.IsCloud != true)
            return null;
        _libraryCts?.Cancel();
        BeginBrowse();
        IsLibraryLoading = false;
        LibraryLoadStatus = string.Empty;
        CloudTree.Clear();
        _openPhoto = null;
        _cloudDoc = null;
        _cloudSidecarLoad = Task.CompletedTask;
        _cloudPreviewPending = null;
        return null;
    }
}
