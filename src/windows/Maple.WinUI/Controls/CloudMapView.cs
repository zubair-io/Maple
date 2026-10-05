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
    private readonly Button _back = new() { Content = "Back to photos and filters" };
    private readonly ListView _results = new() { MaxHeight = 180, SelectionMode = ListViewSelectionMode.None, IsItemClickEnabled = true, DisplayMemberPath = nameof(LocationResult.Label) };
    private readonly CloudClient _client;
    private CloudMapConfig _config;
    private CloudSearchQuery _query;
    private CloudMapViewport? _viewport;
    private CloudMapCell[] _cells = Array.Empty<CloudMapCell>();
    private CancellationTokenSource? _request;
    private readonly CancellationTokenSource _lifetime = new();
    private long _generation;
    private bool _disposed;
    private bool _initialized;
    private bool _initializing;
    private bool _ready;
    private bool _tileError;
    private long _navigationVersion;

    internal int AppliedCellCount => _cells.Length;
    internal bool HostReady => _ready;
    internal bool CanRetry => _retry.Visibility == Visibility.Visible;
    internal string StatusText => _status.Text;
    internal FrameworkElement BackControl => _back;
    internal double CanvasHeight => _browser.ActualHeight;
    internal CloudMapViewport? Viewport => _viewport;
    internal long RequestGeneration => _generation;
    internal event Action<string>? QualificationDiagnostic;

    public void FocusNavigation() => _back.Focus(FocusState.Keyboard);

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
        _back.Click += (_, _) => BackRequested?.Invoke();
        footer.Children.Add(_back);
        footer.Children.Add(_status);
        footer.Children.Add(_retry);
        footer.Children.Add(_results);
        SetRow(footer, 1);
        Children.Add(footer);
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(_results, "Photo locations, keyboard accessible results");
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetLiveSetting(_status, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Polite);
        _results.ItemClick += (_, e) => { if (e.ClickedItem is LocationResult result && _results.IsEnabled) CellSelected?.Invoke(result.Cell); };
        _retry.Click += async (_, _) => await RetryAsync();
        Loaded += async (_, _) => { if (!_initialized) await InitializeAsync(); };
        _browser.SizeChanged += (_, _) => RecordQualificationDiagnostic("canvas-resized");
    }

    public void SetQuery(CloudSearchQuery query)
    {
        if (_query == query) return;
        _query = query;
        if (_viewport is { } viewport) _ = LoadViewportAsync(viewport);
    }

    private async Task InitializeAsync()
    {
        if (_disposed || _initializing) return;
        _initializing = true;
        SetStatus("Loading map…");
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
            NavigateHost();
        }
        catch (Exception) { if (!_disposed) Fail("Map could not start. Check that WebView2 is installed, then retry."); }
        finally { _initializing = false; }
    }

    internal async Task RetryAsync()
    {
        if (_disposed || _initializing) return;
        if (!_initialized) { await InitializeAsync(); return; }
        if (!_ready) { NavigateHost(); return; }
        if (!_tileError && _viewport is { } viewport) { await LoadViewportAsync(viewport); return; }
        _retry.IsEnabled = false;
        try
        {
            var config = await _client.GetMapConfigAsync(_lifetime.Token);
            if (_disposed) return;
            if (config == null) { Fail("This server no longer provides Map. Return to photos."); return; }
            _config = config;
            _tileError = false;
            _retry.Visibility = Visibility.Collapsed;
            SetStatus("Loading map…");
            _browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { type = "configure", tileUrl = _config.TileUrl }));
        }
        catch (Exception) { if (!_disposed) Fail("Map configuration could not load. Check your connection, then retry."); }
        finally { if (!_disposed) _retry.IsEnabled = true; }
    }

    private void NavigateHost()
    {
        _ready = false;
        var version = ++_navigationVersion;
        _browser.CoreWebView2.Navigate($"https://{Host}/index.html");
        _ = WatchHostReadyAsync(version);
    }

    private async Task WatchHostReadyAsync(long version)
    {
        try
        {
            await Task.Delay(TimeSpan.FromSeconds(30), _lifetime.Token);
            if (!_disposed && !_ready && version == _navigationVersion)
                Fail("Map renderer did not start. Retry to try again.");
        }
        catch (OperationCanceledException) when (_disposed) { }
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
                    RecordQualificationDiagnostic("viewport-message");
                    UpdateViewport(new(root.GetProperty("west").GetDouble(), root.GetProperty("south").GetDouble(),
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

    internal void UpdateViewport(CloudMapViewport viewport)
    {
        // MapLibre can emit both style.load and moveend for the same bounds.
        // Preserve the pending request and published cells until bounds change.
        // Query changes and explicit retry still refresh through LoadViewportAsync.
        if (_disposed || _viewport == viewport) return;
        _ = LoadViewportAsync(viewport);
    }

    private async Task LoadViewportAsync(CloudMapViewport viewport)
    {
        _viewport = viewport;
        _request?.Cancel();
        _request?.Dispose();
        var owner = _request = new CancellationTokenSource();
        var generation = ++_generation;
        RecordQualificationDiagnostic("request-started");
        _cells = Array.Empty<CloudMapCell>();
        _results.IsEnabled = false;
        // Keep an existing error and Retry visible while recovering. Removing
        // Retry here changes the canvas bounds and starts another viewport
        // request; a failing server otherwise causes an endless resize loop.
        if (!_tileError && !CanRetry)
        {
            SetStatus("Loading photo locations…");
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
            {
                _retry.Visibility = Visibility.Collapsed;
                SetStatus(cells.Length == 0 ? "No photos with a location in this area match these filters." : $"{cells.Length} photo locations");
            }
            RecordQualificationDiagnostic("cells-published");
        }
        catch (OperationCanceledException) when (owner.IsCancellationRequested)
        { RecordQualificationDiagnostic("request-cancelled"); }
        catch (Exception error)
        {
            if (_disposed || _request != owner) return;
            Fail(error is HttpRequestException { StatusCode: HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden }
                ? "Sign in to Maple Cloud to load photo locations." : "Photo locations could not load. Check your connection, then retry.");
        }
    }

    private void Fail(string message)
    {
        SetStatus(message);
        _retry.Visibility = Visibility.Visible;
    }

    private void SetStatus(string message)
    {
        _status.Text = message;
        var peer = Microsoft.UI.Xaml.Automation.Peers.FrameworkElementAutomationPeer.FromElement(_status);
        peer?.RaiseAutomationEvent(Microsoft.UI.Xaml.Automation.Peers.AutomationEvents.LiveRegionChanged);
    }

    private void RecordQualificationDiagnostic(string phase)
    {
        if (QualificationDiagnostic is not { } diagnostic) return;
        diagnostic(JsonSerializer.Serialize(new { phase, at = DateTimeOffset.UtcNow,
            generation = _generation, viewport = _viewport, cells = _cells.Length,
            resultRows = _results.Items.Count, canvasWidth = _browser.ActualWidth,
            canvasHeight = _browser.ActualHeight, status = _status.Text }));
    }

    public void Dispose()
    {
        _disposed = true;
        _lifetime.Cancel();
        _lifetime.Dispose();
        _request?.Cancel();
        _request?.Dispose();
        _browser.Close();
    }

    private sealed record LocationResult(CloudMapCell Cell)
    {
        public string Label => $"{Cell.Count} photos · {Cell.PlaceLabel ?? "Unnamed location"}";
    }
}
