using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Maple.WinUI.Services;
using Maple.WinUI.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private const int TileCellPixels = 192;
    private const int TileDecodeRounds = 5;
    private const int GridStablePolls = 20;

    private static bool IsPerfTimingMode(string mode) =>
        mode is "launch-timing" or "launch-timing-restored" or "grid-virtualization" or "tile-decode-timing";

    private static bool SmokeRestoresSources(string[] arguments) =>
        Array.IndexOf(arguments, "--lifecycle-smoke") < 0 || Array.IndexOf(arguments, "launch-timing-restored") >= 0;

    private Task RunPerfTimingSmokeAsync(string mode, string input, string output) => mode switch
    {
        "launch-timing" => RecordLaunchTimingAsync(input, output, restored: false),
        "launch-timing-restored" => RecordLaunchTimingAsync(input, output, restored: true),
        "grid-virtualization" => RecordGridVirtualizationAsync(input, output),
        _ => RecordTileDecodeTimingAsync(input, output),
    };

    private async Task RecordLaunchTimingAsync(string expectedFolder, string output, bool restored)
    {
        var root = (FrameworkElement)Content;
        var expected = restored ? Directory.EnumerateFiles(expectedFolder, "*.dng").Count() : 0;
        var loaded = false;
        var firstTickSeen = false;
        var framePresented = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var gridHasItems = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var thumbnailsSet = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var watched = new HashSet<PhotoItem>();

        void Evaluate()
        {
            if (expected == 0) return;
            if (!gridHasItems.Task.IsCompleted && ViewModel.Photos.Count >= expected)
            {
                LaunchTimeline.Mark("grid-has-items");
                gridHasItems.TrySetResult();
            }
            if (!thumbnailsSet.Task.IsCompleted && ViewModel.Photos.Count >= expected
                && ViewModel.Photos.All(photo => photo.ThumbnailPath != null))
            {
                LaunchTimeline.Mark("all-thumbnails-set");
                thumbnailsSet.TrySetResult();
            }
        }
        void Watch(PhotoItem photo)
        {
            if (watched.Add(photo)) photo.PropertyChanged += (_, _) => Evaluate();
        }
        void ScanPhotos()
        {
            foreach (var photo in ViewModel.Photos) Watch(photo);
            Evaluate();
        }
        void OnPhotosChanged(object? sender, NotifyCollectionChangedEventArgs e) => ScanPhotos();
        void OnLoaded(object sender, RoutedEventArgs e)
        {
            root.Loaded -= OnLoaded;
            loaded = true;
            LaunchTimeline.Mark("root-loaded");
        }
        void OnRendering(object? sender, object e)
        {
            if (!firstTickSeen)
            {
                firstTickSeen = true;
                LaunchTimeline.Mark("first-render-tick");
            }
            if (!loaded) return;
            CompositionTarget.Rendering -= OnRendering;
            LaunchTimeline.Mark("first-render-after-loaded");
            framePresented.TrySetResult();
        }
        // Every handler attaches before the first await on this path, on the UI thread that raises these events.
        if (root.IsLoaded)
        {
            loaded = true;
            LaunchTimeline.Mark("root-loaded-before-hook");
        }
        else root.Loaded += OnLoaded;
        CompositionTarget.Rendering += OnRendering;
        ViewModel.Photos.CollectionChanged += OnPhotosChanged;
        ScanPhotos();

        await framePresented.Task.WaitAsync(TimeSpan.FromSeconds(60));
        if (expected > 0)
        {
            await gridHasItems.Task.WaitAsync(TimeSpan.FromSeconds(120));
            try { await thumbnailsSet.Task.WaitAsync(TimeSpan.FromSeconds(60)); }
            catch (TimeoutException) { }
        }
        ViewModel.Photos.CollectionChanged -= OnPhotosChanged;

        using var process = Process.GetCurrentProcess();
        var processStart = process.StartTime.ToUniversalTime();
        var marks = LaunchTimeline.Snapshot()
            .Select(mark => new { name = mark.Name, msSinceProcessStart = (mark.Utc - processStart).TotalMilliseconds })
            .ToArray();
        await File.WriteAllTextAsync(Path.Combine(output, "launch-timing.json"), JsonSerializer.Serialize(new
        {
            processStartUtc = processStart,
            expectedPhotos = expected,
            photosInGrid = ViewModel.Photos.Count,
            thumbnailsSet = ViewModel.Photos.Count(photo => photo.ThumbnailPath != null),
            marks,
        }));
    }

    private async Task RecordGridVirtualizationAsync(string folder, string output)
    {
        var files = Directory.EnumerateFiles(folder, "*.dng").Order(StringComparer.Ordinal).ToArray();
        if (files.Length == 0) throw new InvalidOperationException($"No photos in {folder}");
        var root = (FrameworkElement)Content;
        root.Width = 1280;
        root.Height = 800;
        SetMode(ShellMode.Browse);
        ViewModel.AllPhotos.Clear();
        foreach (var file in files)
        {
            var info = new FileInfo(file);
            ViewModel.AllPhotos.Add(new PhotoItem
            {
                FilePath = file, FileName = info.Name, Format = "DNG",
                FileSizeBytes = info.Length, FileModifiedUtc = info.LastWriteTimeUtc,
            });
        }
        ViewModel.ApplyFilters();
        if (ViewModel.Photos.Count != files.Length)
            throw new InvalidOperationException($"Grid holds {ViewModel.Photos.Count} photos, expected {files.Length}");

        var deadline = Environment.TickCount64 + 30000;
        var stablePolls = 0;
        var previous = -1;
        while (stablePolls < GridStablePolls)
        {
            await Task.Delay(15);
            root.UpdateLayout();
            var current = CountDescendants<GridViewItem>(PhotoGrid);
            stablePolls = current == previous && current > 0 ? stablePolls + 1 : 0;
            previous = current;
            if (Environment.TickCount64 > deadline) throw new TimeoutException("The grid did not settle within 30 seconds");
        }
        var scroll = FindDescendant<ScrollViewer>(PhotoGrid);
        await File.WriteAllTextAsync(Path.Combine(output, "grid-virtualization.json"), JsonSerializer.Serialize(new
        {
            photos = files.Length,
            photosInGrid = ViewModel.Photos.Count,
            realizedGridViewItems = previous,
            itemsPanelChildren = PhotoGrid.ItemsPanelRoot?.Children.Count,
            viewportWidth = PhotoGrid.ActualWidth,
            viewportHeight = PhotoGrid.ActualHeight,
            scrollExtentHeight = scroll?.ExtentHeight,
        }));
    }

    private static int CountDescendants<T>(DependencyObject parent) where T : DependencyObject
    {
        var count = 0;
        for (var index = 0; index < VisualTreeHelper.GetChildrenCount(parent); index++)
        {
            var child = VisualTreeHelper.GetChild(parent, index);
            count += (child is T ? 1 : 0) + CountDescendants<T>(child);
        }
        return count;
    }

    // Each case sets a tile the way one candidate would: the grid's binding today hands the Image a
    // BitmapImage that already has its source; the framework sizes a decode to the element only when
    // the BitmapImage joined the tree before its source was set, and never for Stretch None.
    private static readonly TileDecodeCase[] TileDecodeCases =
    {
        new("grid-binding-today", TileCellPixels, 0, Stretch.UniformToFill, SourceBeforeTree: true),
        new("explicit-cell-decode", TileCellPixels, TileCellPixels, Stretch.UniformToFill, SourceBeforeTree: true),
        new("in-tree-before-source", TileCellPixels, 0, Stretch.UniformToFill, SourceBeforeTree: false),
        new("forced-full-size", 512, 0, Stretch.None, SourceBeforeTree: true),
    };

    private sealed record TileDecodeCase(
        string Name, double ElementSide, int DecodePixelWidth, Stretch Stretch, bool SourceBeforeTree);

    private async Task RecordTileDecodeTimingAsync(string folder, string output)
    {
        var tiles = Directory.GetFiles(folder, "*.png").Order(StringComparer.Ordinal).ToArray();
        if (tiles.Length == 0) throw new InvalidOperationException($"No tiles in {folder}");
        var host = Content as Grid ?? throw new InvalidOperationException("Tile timing requires the root Grid.");
        var rounds = TileDecodeCases.ToDictionary(decode => decode.Name, _ => new List<double>());
        for (var round = -1; round < TileDecodeRounds; round++)
        {
            foreach (var decode in TileDecodeCases)
            {
                var total = 0d;
                foreach (var tile in tiles)
                {
                    total += await TimeImageOpenedAsync(host, tile, decode);
                }
                if (round >= 0) rounds[decode.Name].Add(total / tiles.Length);
            }
        }
        await File.WriteAllTextAsync(Path.Combine(output, "tile-decode-timing.json"), JsonSerializer.Serialize(new
        {
            tiles = tiles.Length, cellPixels = TileCellPixels, roundsExcludingWarmUp = TileDecodeRounds,
            rasterizationScale = host.XamlRoot.RasterizationScale,
            cases = TileDecodeCases.Select(decode => new { name = decode.Name, perTileMeanMsPerRound = rounds[decode.Name] }),
        }));
    }

    private static async Task<double> TimeImageOpenedAsync(Grid host, string path, TileDecodeCase decode)
    {
        var opened = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var image = new Image
        {
            Width = decode.ElementSide, Height = decode.ElementSide, Stretch = decode.Stretch, Opacity = 0.01,
            HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top,
        };
        Grid.SetRow(image, 1);
        image.ImageOpened += (_, _) => opened.TrySetResult();
        image.ImageFailed += (_, e) => opened.TrySetException(new InvalidOperationException($"Tile {path} failed to open: {e.ErrorMessage}"));
        host.Children.Add(image);
        try
        {
            var bitmap = new BitmapImage
            {
                CreateOptions = BitmapCreateOptions.IgnoreImageCache, DecodePixelWidth = decode.DecodePixelWidth,
            };
            var source = new Uri(path);
            var started = Stopwatch.GetTimestamp();
            if (decode.SourceBeforeTree)
            {
                bitmap.UriSource = source;
                image.Source = bitmap;
            }
            else
            {
                image.Source = bitmap;
                bitmap.UriSource = source;
            }
            await opened.Task.WaitAsync(TimeSpan.FromSeconds(30));
            return Stopwatch.GetElapsedTime(started).TotalMilliseconds;
        }
        finally { host.Children.Remove(image); }
    }
}
