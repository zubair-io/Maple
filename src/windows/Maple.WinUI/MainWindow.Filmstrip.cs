using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using Microsoft.UI.Xaml.Media.Imaging;
using Maple.UI;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI
{
    /// <summary>The viewer's filmstrip (#3402): one Maple.UI Filmstrip Rail
    /// on the canvas's left edge, shared by Preview and Edit. Its cells are
    /// the current ViewModel.Photos in grid order, the active cell follows
    /// SelectedPhoto, and activating a cell is a selection change on
    /// whatever surface is showing — never a mode change. The mode-keyed
    /// rules live in the WinUI-free <see cref="ViewerFilmstripLogic"/>.</summary>
    public sealed partial class MainWindow
    {
        /// <summary>Thumbnails decode at twice the rail's 72px cell so they
        /// stay crisp at 200% scaling without holding a full-size thumb per
        /// cell — the rail is a plain stack, every cell is live at once.</summary>
        private const int RailDecodeWidth = 144;

        private List<PhotoItem> _railPhotos = new();
        private List<BitmapImage> _railBitmaps = new();
        private bool _railDirty = true;
        private bool _railRebuildQueued;

        private void HookFilmstripRail()
        {
            FilmstripRail.Activated += OnFilmstripActivated;
            ViewModel.Photos.CollectionChanged += (_, _) => InvalidateFilmstripRail();
        }

        /// <summary>Photos repopulates one Add at a time (Library.cs), so a
        /// rebuild per event would be quadratic in the folder size: coalesce
        /// to one rebuild per dispatcher turn, and only while the rail is
        /// showing — a dirty rail is rebuilt on the way into Preview/Edit
        /// (SetMode) instead of behind the Browse grid.</summary>
        private void InvalidateFilmstripRail()
        {
            _railDirty = true;
            if (!ViewerFilmstripLogic.IsRailVisible(_mode) || _railRebuildQueued) return;
            _railRebuildQueued = true;
            DispatcherQueue.TryEnqueue(() =>
            {
                _railRebuildQueued = false;
                if (_railDirty && ViewerFilmstripLogic.IsRailVisible(_mode))
                    RebuildFilmstripRail();
            });
        }

        private void RebuildFilmstripRail()
        {
            foreach (var photo in _railPhotos)
                photo.PropertyChanged -= OnRailPhotoPropertyChanged;

            var photos = ViewModel.Photos.ToList();
            var bitmaps = photos.Select(RailBitmapFor).ToList();
            foreach (var photo in photos)
                photo.PropertyChanged += OnRailPhotoPropertyChanged;

            _railPhotos = photos;
            _railBitmaps = bitmaps;
            _railDirty = false;
            FilmstripRail.Items = photos
                .Select((photo, i) => new MuiFilmstripItem(
                    ViewerFilmstripLogic.IdAt(i), bitmaps[i], photo.FileName,
                    ViewerFilmstripLogic.CullingBadgesFor(photo.Rating, photo.FlagStatus)))
                .ToList();
            SyncFilmstripRailActive();
        }

        /// <summary>One mutable bitmap per cell: thumbnails arrive
        /// asynchronously after the list does (ThumbnailService), and a
        /// rename clears and regenerates one, so the cell keeps its
        /// BitmapImage and only the UriSource moves — no strip rebuild per
        /// thumbnail.</summary>
        private static BitmapImage RailBitmapFor(PhotoItem photo) =>
            new() { DecodePixelWidth = RailDecodeWidth, UriSource = RailUri(photo.ThumbnailPath) };

        private static Uri? RailUri(string? thumbnailPath) =>
            thumbnailPath is null ? null : new Uri(thumbnailPath);

        private void SyncFilmstripRailActive() =>
            FilmstripRail.ActiveId = ViewerFilmstripLogic.ActiveIdFor(_railPhotos, ViewModel.SelectedPhoto);

        private void OnRailPhotoPropertyChanged(object? sender, PropertyChangedEventArgs e)
        {
            if (sender is not PhotoItem photo) return;
            if (e.PropertyName is nameof(PhotoItem.FileName) or nameof(PhotoItem.Rating) or nameof(PhotoItem.FlagStatus))
            {
                // Accessible names and passive culling badges live in the
                // item record; thumbnail changes still reuse their bitmap.
                InvalidateFilmstripRail();
                return;
            }
            if (e.PropertyName != nameof(PhotoItem.ThumbnailPath)) return;
            var index = _railPhotos.IndexOf(photo);
            if (index >= 0)
                _railBitmaps[index].UriSource = RailUri(photo.ThumbnailPath);
        }

        private void OnFilmstripActivated(object? sender, string id)
        {
            var activation = ViewerFilmstripLogic.Activate(_mode, _railPhotos, id, ViewModel.SelectedPhoto);
            if (activation.Photo != null)
                ViewModel.SelectedPhoto = activation.Photo;   // Edit re-decodes via OnSelectedPhotoChanged
            // The mode is the reducer's decision, applied here rather than
            // assumed, so "a filmstrip tap stays on the current surface" is
            // one tested rule instead of an accident of this handler.
            if (activation.Mode != _mode)
                SetMode(activation.Mode);
        }
    }
}
