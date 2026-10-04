using System;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    // #4154: qualify an actually unsupported source, separately from the
    // strict native-patch assertion for supported fixtures.
    private async Task VerifySourceSizeFallbackAsync(string raw, string output)
    {
        var photo = new PhotoItem { FilePath = raw, FileName = Path.GetFileName(raw),
            Format = Path.GetExtension(raw).TrimStart('.').ToUpperInvariant() };
        ViewModel.AllPhotos.Add(photo);
        ViewModel.ApplyFilters();
        ViewModel.SelectedPhoto = photo;
        SetMode(ShellMode.Preview);
        if (!ReferenceEquals(photo, ViewModel.SelectedPhoto))
            throw new InvalidOperationException("Owned fallback fixture was not selected in the production library.");
        EnsureSourceGeometry();
        await _geometryWork;
        var failure = _sourceGeometryError;
        if (failure == null || _nativeGeometry != null)
            throw new InvalidOperationException($"This diagnostic requires unsupported source geometry: error={failure}, geometry={_nativeGeometry}, status={ZoomReadout.Text}, selected={ReferenceEquals(photo, ViewModel.SelectedPhoto)}");
        QueueDetailRefresh();
        if (ZoomReadout.Text != failure || NativeDetailOverlay.Visibility == Visibility.Visible)
            throw new InvalidOperationException("Refresh hid the unsupported-source fallback or presented native detail.");

        var ready = Path.Combine(output, "source-size-fallback.ready");
        await File.WriteAllTextAsync(ready, JsonSerializer.Serialize(new
            { status = ZoomReadout.Text, action = "Capture status, press Ctrl+1, capture again, then acknowledge" }));
        var deadline = DateTime.UtcNow.AddMinutes(5);
        while (!File.Exists(ready + ".continue") && DateTime.UtcNow < deadline) await Task.Delay(100);
        if (!File.Exists(ready + ".continue")) throw new TimeoutException("Source-size UI checkpoint not acknowledged.");
        await _geometryWork;
        QueueDetailRefresh();
        if (_sourceGeometryError == null || ZoomReadout.Text != _sourceGeometryError
            || _nativeGeometry != null || NativeDetailOverlay.Visibility == Visibility.Visible)
            throw new InvalidOperationException("Actual Size/refresh claimed native detail for an unsupported source.");
        ViewModel.SelectedPhoto = null;
        if (_sourceGeometryError != null || ZoomReadout.Text != "Fit")
            throw new InvalidOperationException("Source change retained the previous source failure.");
    }
}
