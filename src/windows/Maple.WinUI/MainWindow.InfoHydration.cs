using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI;
using Maple.WinUI.Services.Metadata;
using Maple.WinUI.Services.Xmp;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private PhotoItem? _metadataPhoto;
    private CancellationTokenSource? _infoCancellation;

    private void CancelInspectorHydration()
    {
        _infoCancellation?.Cancel();
        _infoCancellation?.Dispose();
        _infoCancellation = null;
        _metadataPhoto = null;
    }

    private async void HydrateInspector()
    {
        var photo = ViewModel.SelectedPhoto;
        if (ReferenceEquals(photo, _metadataPhoto)) return;
        _infoCancellation?.Cancel();
        _infoCancellation?.Dispose();
        _infoCancellation = null;
        _metadataPhoto = null;
        ExtraInfoRows.Children.Clear();
        if (photo == null || !_infoPaneOpen || _mode != ShellMode.Preview) return;
        _metadataPhoto = photo;
        var cancellation = new CancellationTokenSource();
        _infoCancellation = cancellation;
        var token = cancellation.Token;
        AddInspectorText("Loading metadata…");
        try
        {
            string? xml = null;
            Services.Cloud.CloudInspectorMetadata? cloud = null;
            var unavailable = false;
            if (photo.IsCloud)
            {
                var client = ViewModel.ActiveCloudClient;
                if (client != null)
                {
                    var xmp = client.GetXmpAsync(photo.FilePath, token);
                    var enrichment = client.GetInspectorMetadataAsync(photo.FilePath, token);
                    await Task.WhenAll(xmp, enrichment);
                    xml = xmp.Result;
                    cloud = enrichment.Result;
                    unavailable = cloud == null;
                }
                else unavailable = true;
            }
            else
            {
                var path = SidecarStore.SidecarPathFor(photo.FilePath);
                xml = await Task.Run(() =>
                {
                    if (!File.Exists(path)) return null;
                    using var stream = File.OpenRead(path);
                    if (stream.Length > 4 * 1024 * 1024) throw new IOException("Sidecar exceeds metadata read limit.");
                    using var reader = new StreamReader(stream);
                    return reader.ReadToEnd();
                }, token);
            }
            var localRows = await Task.Run(() => InspectorMetadata.ReadXmp(xml), token);
            if (token.IsCancellationRequested || _closing || !ReferenceEquals(photo, ViewModel.SelectedPhoto)) return;
            ExtraInfoRows.Children.Clear();
            if (localRows.Count == 0) AddInspectorText("No caption, keywords or location in the sidecar.");
            foreach (var (label, value) in localRows) AddInspectorField(label, value);
            if (photo.IsCloud)
            {
                AddInspectorText("Server enrichment");
                if (unavailable) AddInspectorText("Not available. The server may be offline or this photo is not indexed.");
                else if (cloud!.Rows().Count == 0) AddInspectorText("No enrichment available for this photo.");
                else foreach (var (label, value) in cloud.Rows()) AddInspectorField(label, value);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Xml.XmlException or System.Net.Http.HttpRequestException)
        {
            if (!token.IsCancellationRequested && !_closing && ReferenceEquals(photo, ViewModel.SelectedPhoto))
            {
                ExtraInfoRows.Children.Clear();
                AddInspectorText("Metadata could not be read. The photo remains available for browsing.");
            }
        }
    }

    private void AddInspectorText(string value) => ExtraInfoRows.Children.Add(new TextBlock
    {
        Text = value,
        TextWrapping = TextWrapping.Wrap,
        FontSize = 12,
        Foreground = (Brush)Application.Current.Resources["MapleTextMuted"],
    });

    private void AddInspectorField(string label, string value) => ExtraInfoRows.Children.Add(new MuiLabelValueGrid
    {
        Rows = new[] { new MuiLabelValueRow(label, value) },
    });
}
