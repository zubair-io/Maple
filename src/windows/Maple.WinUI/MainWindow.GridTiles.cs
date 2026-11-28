using System;
using System.Collections.Generic;
using System.ComponentModel;
using Maple.WinUI.Services;
using Maple.WinUI.ViewModels;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Imaging;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private readonly Dictionary<Image, (PhotoItem Photo, PropertyChangedEventHandler Handler)> _gridTiles = new();

    private double GridTileCellDip => PhotoGrid.ItemsPanelRoot is ItemsWrapGrid panel ? panel.ItemWidth : TileCellPixels;

    private double _gridTileScaleApplied = 1.0;

    private double GridTileScale => PhotoGrid.XamlRoot?.RasterizationScale ?? 1.0;

    private void BindGridTile(Image tile, PhotoItem photo)
    {
        ReleaseGridTile(tile);
        PropertyChangedEventHandler handler = (_, args) =>
        {
            if (args.PropertyName == nameof(PhotoItem.ThumbnailPath)) ApplyGridTileSource(tile, photo);
        };
        photo.PropertyChanged += handler;
        _gridTiles[tile] = (photo, handler);
        ApplyGridTileSource(tile, photo);
    }

    private void ReleaseGridTile(Image tile)
    {
        if (!_gridTiles.Remove(tile, out var bound)) return;
        bound.Photo.PropertyChanged -= bound.Handler;
        tile.Source = null;
    }

    private XamlRoot? _watchedGridXamlRoot;

    private void WatchGridXamlRoot()
    {
        if (ReferenceEquals(_watchedGridXamlRoot, PhotoGrid.XamlRoot)) return;
        UnwatchGridXamlRoot();
        _watchedGridXamlRoot = PhotoGrid.XamlRoot;
        if (_watchedGridXamlRoot != null) _watchedGridXamlRoot.Changed += OnGridXamlRootChanged;
    }

    private void UnwatchGridXamlRoot()
    {
        if (_watchedGridXamlRoot != null) _watchedGridXamlRoot.Changed -= OnGridXamlRootChanged;
        _watchedGridXamlRoot = null;
    }

    private void ReleaseAllGridTiles()
    {
        UnwatchGridXamlRoot();
        foreach (var (tile, bound) in _gridTiles)
        {
            bound.Photo.PropertyChanged -= bound.Handler;
            tile.Source = null;
        }
        _gridTiles.Clear();
    }

    private void OnGridXamlRootChanged(XamlRoot sender, XamlRootChangedEventArgs args)
    {
        if (GridTileScale != _gridTileScaleApplied) RefreshGridTileDecodes();
    }

    private void RefreshGridTileDecodes()
    {
        _gridTileScaleApplied = GridTileScale;
        foreach (var (tile, bound) in _gridTiles) ApplyGridTileSource(tile, bound.Photo, redecode: true);
    }

    private void ApplyGridTileSource(Image tile, PhotoItem photo, bool redecode = false)
    {
        if (!DispatcherQueue.HasThreadAccess)
        {
            DispatcherQueue.TryEnqueue(() => ApplyGridTileSource(tile, photo, redecode));
            return;
        }
        if (!_gridTiles.TryGetValue(tile, out var bound) || !ReferenceEquals(bound.Photo, photo)) return;
        tile.Source = photo.ThumbnailPath is { } path ? GridTileBitmap(new Uri(path), redecode) : null;
    }

    private BitmapImage GridTileBitmap(Uri source, bool redecode)
    {
        var decode = source.IsFile
            ? TileDecodeSize.ForFile(source.LocalPath, GridTileCellDip, GridTileScale)
            : default;
        var bitmap = new BitmapImage();
        if (redecode) bitmap.CreateOptions = BitmapCreateOptions.IgnoreImageCache;
        if (decode.PixelWidth is { } width) bitmap.DecodePixelWidth = width;
        if (decode.PixelHeight is { } height) bitmap.DecodePixelHeight = height;
        bitmap.UriSource = source;
        return bitmap;
    }
}
