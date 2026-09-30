using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Maple.WinUI.Services.Cloud;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;

namespace Maple.WinUI.Controls;

public sealed class CloudMapView : Grid, IDisposable
{
    private const string Host = "maple-map.invalid";
    private readonly WebView2 _browser = new();
    private readonly TextBlock _status = new() { TextWrapping = TextWrapping.Wrap };
    private readonly Button _retry = new() { Content = "Retry map", Visibility = Visibility.Collapsed };
    private readonly ListView _results = new() { MaxHeight = 180, SelectionMode = ListViewSelectionMode.None, IsItemClickEnabled = true, DisplayMemberPath = nameof(LocationResult.Label) };
    private readonly CloudClient _client;
    private readonly CloudMapConfig _config;
    private CloudSearchQuery _query;
    private CloudMapViewport? _viewport;
    private CloudMapCell[] _cells = Array.Empty<CloudMapCell>();
    private CancellationTokenSource? _request;
    private long _generation;
    private bool _disposed;
    private bool _initialized;
    private bool _ready;
    private bool _tileError;

    internal int AppliedCellCount => _cells.Length;
    internal bool HostReady => _ready;

    public event Action<CloudMapCell>? CellSelected;
    public event Action? BackRequested;

    public CloudMapView(CloudClient client, CloudMapConfig config, CloudSearchQuery query)
    {
        _client = client;
        _config = config;
        _query = query;
        RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        Children.Add(_browser);
        var footer = new StackPanel { Spacing = 8, Padding = new Thickness(12) };
        var back = new Button { Content = "Back to photos and filters" };
        back.Click += (_, _) => BackRequested?.Invoke();
        footer.Children.Add(back);
        footer.Children.Add(_status);
        footer.Children.Add(_retry);
        footer.Children.Add(_results);
        SetRow(footer, 1);
        Children.Add(footer);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(_results, "Photo locations, keyboard accessible results");
        _results.ItemClick += (_, e) => { if (e.ClickedItem is LocationResult result && _results.IsEnabled) CellSelected?.Invoke(result.Cell); };
        _retry.Click += async (_, _) =>
        {
            _tileError = false;
            if (!_initialized) await InitializeAsync();
            else if (_ready) _browser.CoreWebView2.PostWebMessageAsJson("{\"type\":\"retry\"}");
            else _browser.CoreWebView2.Navigate($"https://{Host}/index.html");
        };
        Loaded += async (_, _) => { if (!_initialized) await InitializeAsync(); };
    }

    public void SetQuery(CloudSearchQuery query)
    {
        if (_query == query) return;
        _query = query;
        if (_viewport is { } viewport) _ = LoadViewportAsync(viewport);
    }

    private async Task InitializeAsync()
    {
        _status.Text = "Loading map…";
        _retry.Visibility = Visibility.Collapsed;
        try
        {
            await _browser.EnsureCoreWebView2Async();
            if (_disposed) return;
            var core = _browser.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.UserAgent = "MapleWindows/1.0 (+https://github.com/zubair-io/Maple)";
            core.SetVirtualHostNameToFolderMapping(Host, Path.Combine(AppContext.BaseDirectory, "Assets", "Map"), CoreWebView2HostResourceAccessKind.DenyCors);
            core.NewWindowRequested += async (_, e) =>
            {
                e.Handled = true;
                if (e.IsUserInitiated && Uri.TryCreate(e.Uri, UriKind.Absolute, out var link)
                    && (link.Scheme == Uri.UriSchemeHttps || link.Scheme == Uri.UriSchemeHttp))
                    await Windows.System.Launcher.LaunchUriAsync(link);
            };
            core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
            core.NavigationStarting += (_, e) => e.Cancel = e.Uri != $"https://{Host}/index.html";
            core.WebMessageReceived += OnMessage;
            core.NavigationCompleted += (_, e) => { if (!e.IsSuccess && !_disposed) Fail("Map could not start. Retry to try again."); };
            _initialized = true;
            core.Navigate($"https://{Host}/index.html");
        }
        catch (Exception) { if (!_disposed) Fail("Map could not start. Check that WebView2 is installed, then retry."); }
    }

    private void OnMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (_disposed || e.Source != $"https://{Host}/index.html") return;
        try
        {
            using var message = JsonDocument.Parse(e.WebMessageAsJson);
            var root = message.RootElement;
            switch (root.GetProperty("type").GetString())
            {
                case "ready":
                    _ready = true;
                    _browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "configure", tileUrl = _config.TileUrl }));
                    break;
                case "viewport":
                    _ = LoadViewportAsync(new(root.GetProperty("west").GetDouble(), root.GetProperty("south").GetDouble(),
                        root.GetProperty("east").GetDouble(), root.GetProperty("north").GetDouble(), root.GetProperty("zoom").GetInt32()));
                    break;
                case "select":
                    var index = root.GetProperty("index").GetInt32();
                    if (root.GetProperty("generation").GetInt64() == _generation && index >= 0 && index < _cells.Length)
                        CellSelected?.Invoke(_cells[index]);
                    break;
                case "tileError":
                    _tileError = true;
                    Fail("Map tiles could not load. Check your connection or server tile configuration, then retry.");
                    break;
            }
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or KeyNotFoundException or FormatException)
        { Fail("Map returned an invalid response. Retry to try again."); }
    }

    private async Task LoadViewportAsync(CloudMapViewport viewport)
    {
        _viewport = viewport;
        _request?.Cancel();
        _request?.Dispose();
        var owner = _request = new CancellationTokenSource();
        var generation = ++_generation;
        _cells = Array.Empty<CloudMapCell>();
        _results.IsEnabled = false;
        if (!_tileError)
        {
            _status.Text = "Loading photo locations…";
            _retry.Visibility = Visibility.Collapsed;
        }
        try
        {
            await Task.Delay(200, owner.Token);
            var cells = await _client.GetMapClustersAsync(viewport, _query, owner.Token);
            if (_disposed || _request != owner || owner.IsCancellationRequested) return;
            _cells = cells;
            _browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "cells", cells, generation }));
            _results.Items.Clear();
            foreach (var cell in cells)
                _results.Items.Add(new LocationResult(cell));
            _results.IsEnabled = true;
            if (!_tileError)
                _status.Text = cells.Length == 0 ? "No photos with a location in this area match these filters." : $"{cells.Length} photo locations";
        }
        catch (OperationCanceledException) when (owner.IsCancellationRequested) { }
        catch (Exception error)
        {
            if (_disposed || _request != owner) return;
            Fail(error is HttpRequestException { StatusCode: HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden }
                ? "Sign in to Maple Cloud to load photo locations." : "Photo locations could not load. Check your connection, then retry.");
        }
    }

    private void Fail(string message)
    {
        _status.Text = message;
        _retry.Visibility = Visibility.Visible;
    }

    public void Dispose()
    {
        _disposed = true;
        _request?.Cancel();
        _request?.Dispose();
        _browser.Close();
    }

    private sealed record LocationResult(CloudMapCell Cell)
    {
        public string Label => $"{Cell.Count} photos · {Cell.PlaceLabel ?? "Unnamed location"}";
    }
}
