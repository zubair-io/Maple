using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Pages
{
    /// <summary>
    /// Maple.UI TV Viewer page (unified-component-catalog.md §6 — App
    /// Shell template hosting a single Preview Surface). Windows Pages
    /// wave (#3012).
    ///
    /// Real wiring: large remote-friendly Prev/Next buttons in the
    /// shell's Navigation region step through the Iceland Roadtrip set
    /// via the same <see cref="MuiFilmstripNavReducer.Move"/> the desktop
    /// Preview page uses (wraps at either end) — one wrap-around rule,
    /// two callers, rather than a TV-specific reimplementation.
    /// </summary>
    public sealed class MuiPageTVViewer : ContentControl
    {
        private readonly MuiPreviewSurface _surface = new();
        private readonly List<MuiMockAsset> _assets;
        private string _activeId;

        public MuiPageTVViewer()
        {
            _assets = MuiPageMockLibrary.Assets.Where(a => a.FolderId == "iceland").ToList();
            _activeId = _assets[0].Id;

            _surface.FilmstripItems = _assets
                .Select(a => new MuiFilmstripItem(a.Id, MuiPageBitmap.ForAsset(a), a.Filename))
                .ToList();
            _surface.FilmstripActivated += (_, id) => { _activeId = id; RefreshSurface(); };

            var prevButton = new MuiButton { Variant = MuiButtonVariant.Secondary, ButtonSize = MuiButtonSize.Lg, Label = "◀ Prev" };
            var nextButton = new MuiButton { Variant = MuiButtonVariant.Secondary, ButtonSize = MuiButtonSize.Lg, Label = "Next ▶" };
            prevButton.Click += (_, _) => Step(-1);
            nextButton.Click += (_, _) => Step(1);

            var nav = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Spacing = 16,
                Padding = new Thickness(24, 16, 24, 16),
                Children = { prevButton, nextButton },
            };

            var shell = new MuiAppShell { Navigation = nav, MainContent = _surface };
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

        private void RefreshSurface()
        {
            var asset = _assets.First(a => a.Id == _activeId);
            _surface.Title = asset.Filename;
            _surface.Source = MuiPageBitmap.ForAsset(asset);
            _surface.ActiveId = _activeId;
        }
    }
}
