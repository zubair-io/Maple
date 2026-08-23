using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Pages
{
    /// <summary>
    /// Maple.UI Preview page (unified-component-catalog.md §6 — App
    /// Shell template hosting a single Preview Surface). Windows Pages
    /// wave (#3012).
    ///
    /// Real wiring: Prev/Next nav buttons in the shell's Navigation
    /// region step the Preview Surface's active asset through
    /// <see cref="MuiFilmstripNavReducer.Move"/> (wraps at either end —
    /// the same reducer TV Viewer reuses for its own remote-control
    /// stepping); a toolbar action shows a dismissible confirmation
    /// Banner in the shell's Overlay region rather than silently doing
    /// nothing.
    /// </summary>
    public sealed class MuiPagePreview : ContentControl
    {
        private readonly MuiPreviewSurface _surface = new();
        private readonly MuiBanner _overlayBanner = new() { Variant = MuiBannerVariant.Info, Dismissible = true, Visibility = Visibility.Collapsed };
        private readonly List<MuiMockAsset> _assets;
        private string _activeId;

        public MuiPagePreview()
        {
            _assets = MuiPageMockLibrary.Assets.Where(a => a.FolderId.StartsWith("wedding")).ToList();
            _activeId = _assets[0].Id;

            _surface.ToolbarEntries = new[]
            {
                MuiToolbarEntry.For(new MuiToolbarItem("share", "share-up-square", "Share")),
                MuiToolbarEntry.For(new MuiToolbarItem("export", "export", "Export")),
            };
            _surface.FilmstripItems = _assets
                .Select(a => new MuiFilmstripItem(a.Id, MuiPageBitmap.ForAsset(a), a.Filename))
                .ToList();
            _surface.BackRequested += (_, _) => ShowBanner("Returning to Browse…");
            _surface.ToolbarActionSelected += (_, actionId) => ShowBanner($"{actionId} queued for this photo.");
            _surface.FilmstripActivated += (_, id) => { _activeId = id; RefreshSurface(); };

            var prevButton = new MuiButton { Variant = MuiButtonVariant.Ghost, Label = "Prev", IconName = "chevron-left" };
            var nextButton = new MuiButton { Variant = MuiButtonVariant.Ghost, Label = "Next", IconName = "chevron-right" };
            prevButton.Click += (_, _) => Step(-1);
            nextButton.Click += (_, _) => Step(1);

            var nav = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Spacing = 8,
                Padding = new Thickness(16, 8, 16, 8),
                Children = { prevButton, new MuiText { Text = "Ceremony + Reception", Variant = MuiTextVariant.RowLabel, VerticalAlignment = VerticalAlignment.Center }, nextButton },
            };

            _overlayBanner.ActionPressed += (_, _) => _overlayBanner.Visibility = Visibility.Collapsed;
            _overlayBanner.Dismissed += (_, _) => _overlayBanner.Visibility = Visibility.Collapsed;

            var shell = new MuiAppShell
            {
                Navigation = nav,
                MainContent = _surface,
                Overlay = _overlayBanner,
            };
            Content = shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            RefreshSurface();
        }

        private void Step(int delta)
        {
            var ids = _assets.Select(a => a.Id).ToList();
            _activeId = MuiFilmstripNavReducer.Move(ids, _activeId, delta) ?? _activeId;
            RefreshSurface();
        }

        private void ShowBanner(string message)
        {
            _overlayBanner.Message = message;
            _overlayBanner.Visibility = Visibility.Visible;
        }

        private void RefreshSurface()
        {
            var asset = _assets.First(a => a.Id == _activeId);
            _surface.Title = asset.Filename;
            _surface.Source = MuiPageBitmap.ForAsset(asset);
            _surface.ActiveId = _activeId;
        }
    }
}
