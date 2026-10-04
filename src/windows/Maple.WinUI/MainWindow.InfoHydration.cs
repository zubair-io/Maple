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
            var sidecarUnavailable = false;
            if (photo.IsCloud)
            {
                var client = ViewModel.ActiveCloudClient;
                if (client != null)
                {
                    var snapshot = await client.ReadInspectorAsync(photo.FilePath, token);
                    xml = snapshot.Xmp;
                    cloud = snapshot.Enrichment;
                    unavailable = snapshot.EnrichmentUnavailable;
                    sidecarUnavailable = snapshot.SidecarUnavailable;
                }
                else sidecarUnavailable = unavailable = true;
            }
            else
            {
                var path = SidecarStore.SidecarPathFor(photo.FilePath);
                xml = await Task.Run(async () =>
                {
                    if (!File.Exists(path)) return null;
                    using var stream = File.OpenRead(path);
                    if (stream.Length > 4 * 1024 * 1024) throw new IOException("Sidecar exceeds metadata read limit.");
                    using var reader = new StreamReader(stream);
                    return await reader.ReadToEndAsync(token);
                }, token);
            }
            System.Collections.Generic.IReadOnlyList<(string Label, string Value)> localRows;
            try { localRows = await Task.Run(() => InspectorMetadata.ReadXmp(xml), token); }
            catch (System.Xml.XmlException error)
            {
                Services.DiagLog.Write($"[inspector] unreadable sidecar: {error.Message}");
                sidecarUnavailable = true;
                localRows = Array.Empty<(string, string)>();
            }
            if (token.IsCancellationRequested || _closing || !ReferenceEquals(photo, ViewModel.SelectedPhoto)) return;
            ExtraInfoRows.Children.Clear();
            if (sidecarUnavailable) AddInspectorText("Sidecar metadata is currently unavailable.");
            else if (localRows.Count == 0) AddInspectorText("No caption, keywords or location in the sidecar.");
            foreach (var (label, value) in localRows) AddInspectorField(label, value);
            if (photo.IsCloud)
            {
                AddInspectorText("Server enrichment");
                if (unavailable) AddInspectorText("Not available. The server may be offline or this photo is not indexed.");
                else if (cloud!.Rows().Count == 0) AddInspectorText("No enrichment available for this photo.");
                else foreach (var (label, value) in cloud.Rows()) AddInspectorField(label, value);
            }
            if (sidecarUnavailable || unavailable) AddInspectorRetry();
        }
        catch (OperationCanceledException) { }
        catch (Exception error)
        {
            Services.DiagLog.Write($"[inspector] {error.Message}");
            if (!token.IsCancellationRequested && !_closing && ReferenceEquals(photo, ViewModel.SelectedPhoto))
            {
                ExtraInfoRows.Children.Clear();
                AddInspectorText("Metadata could not be read. The photo remains available for browsing.");
                AddInspectorRetry();
            }
        }
    }

    private void AddInspectorRetry()
    {
        var retry = new Maple.UI.Atoms.MuiButton { Label = "Retry metadata", Height = 44 };
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(retry, "Retry photo metadata");
        retry.Click += (_, _) => { CancelInspectorHydration(); HydrateInspector(); };
        ExtraInfoRows.Children.Add(retry);
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
