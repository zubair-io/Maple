using System;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Controls;
using Maple.WinUI.Services.Cloud;
using Microsoft.UI.Xaml;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private CloudMapView? _cloudMap;
    private CloudClient? _mapClient;
    private CloudMapConfig? _mapConfig;
    private CancellationTokenSource? _mapProbe;

    private void InitializeCloudMap()
    {
        ViewModel.PropertyChanged += (_, e) =>
        {
            if (_closing) return;
            if (e.PropertyName is nameof(ViewModel.CloudConnected) or nameof(ViewModel.CloudStatus))
                _ = ProbeMapAsync();
            if (CloudMapContainer.Visibility == Visibility.Visible)
                _cloudMap?.SetQuery(ViewModel.CurrentTimelineQuery());
        };
        _ = ProbeMapAsync();
    }

    private async Task ProbeMapAsync()
    {
        var client = ViewModel.CloudConnected ? ViewModel.ActiveCloudClient : null;
        if (client == _mapClient) return;
        DisposeCloudMap();
        _mapClient = client;
        CloudMapButton.Visibility = Visibility.Collapsed;
        if (client == null) return;
        var owner = _mapProbe = new CancellationTokenSource();
        try
        {
            var config = await client.GetMapConfigAsync(owner.Token);
            if (_closing || _mapProbe != owner || owner.IsCancellationRequested) return;
            _mapConfig = config;
            CloudMapButton.Visibility = config == null ? Visibility.Collapsed : Visibility.Visible;
            CloudMapButton.Label = "Map";
        }
        catch (OperationCanceledException) when (owner.IsCancellationRequested) { }
        catch (Exception)
        {
            if (_closing || _mapProbe != owner) return;
            CloudMapButton.Label = "Retry Map connection";
            CloudMapButton.Visibility = Visibility.Visible;
        }
    }

    private async void OnMapInvoked(object sender, RoutedEventArgs e)
    {
        if (_mapConfig == null)
        {
            _mapClient = null;
            await ProbeMapAsync();
        }
        if (_mapClient == null || _mapConfig == null || _closing) return;
        SetMode(ShellMode.Browse);
        if (_cloudMap == null)
        {
            _cloudMap = new CloudMapView(_mapClient, _mapConfig, ViewModel.CurrentTimelineQuery());
            _cloudMap.BackRequested += () => SetMode(ShellMode.Browse);
            _cloudMap.CellSelected += async cell =>
            {
                SetMode(ShellMode.Browse);
                ViewModel.SearchText = cell.PlaceLabel ?? "";
                ViewModel.CloudSearchScope = cell.PlaceLabel == null ? CloudSearchScope.Places : CloudSearchScope.Photos;
                await ViewModel.LoadCloudTimelineAsync(preserveDateFilter: true);
            };
            CloudMapContainer.Children.Add(_cloudMap);
        }
        _cloudMap.SetQuery(ViewModel.CurrentTimelineQuery());
        BrowseGridContainer.Visibility = Visibility.Collapsed;
        CloudMapContainer.Visibility = Visibility.Visible;
        _cloudMap.FocusNavigation();
    }

    private void DisposeCloudMap()
    {
        _mapProbe?.Cancel();
        _mapProbe?.Dispose();
        _mapProbe = null;
        _cloudMap?.Dispose();
        _cloudMap = null;
        _mapConfig = null;
        CloudMapContainer.Children.Clear();
        if (CloudMapContainer.Visibility == Visibility.Visible)
        {
            CloudMapContainer.Visibility = Visibility.Collapsed;
            BrowseGridContainer.Visibility = Visibility.Visible;
        }
    }
}
