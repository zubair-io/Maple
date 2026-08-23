using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Preview Surface organism (unified-component-catalog.md
    /// §4.5, "Preview Surface" row: "Full-screen media preview", built
    /// from Page Header, Filmstrip, Preview Image, Video Player,
    /// Toolbar) — a <see cref="MuiPageHeader"/> (title + back/more), a
    /// centered <see cref="MuiPreviewImage"/> or <see cref="MuiVideoPlayer"/>
    /// depending on <see cref="IsVideo"/>, a floating action
    /// <see cref="MuiToolbar"/>, and a bottom <see cref="MuiFilmstrip"/>
    /// for stepping between assets without leaving full-screen.
    /// </summary>
    public sealed class MuiPreviewSurface : ContentControl
    {
        public static readonly DependencyProperty TitleProperty =
            DependencyProperty.Register(nameof(Title), typeof(string), typeof(MuiPreviewSurface),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiPreviewSurface)d)._header.Title = (string)e.NewValue));

        public static readonly DependencyProperty SourceProperty =
            DependencyProperty.Register(nameof(Source), typeof(ImageSource), typeof(MuiPreviewSurface),
                new PropertyMetadata(null, (d, e) => ((MuiPreviewSurface)d)._image.Source = (ImageSource?)e.NewValue));

        public static readonly DependencyProperty IsVideoProperty =
            DependencyProperty.Register(nameof(IsVideo), typeof(bool), typeof(MuiPreviewSurface),
                new PropertyMetadata(false, (d, _) => ((MuiPreviewSurface)d).Rebuild()));

        public static readonly DependencyProperty VideoPosterProperty =
            DependencyProperty.Register(nameof(VideoPoster), typeof(ImageSource), typeof(MuiPreviewSurface),
                new PropertyMetadata(null, (d, e) => ((MuiPreviewSurface)d)._video.Poster = (ImageSource?)e.NewValue));

        public static readonly DependencyProperty VideoDurationSecondsProperty =
            DependencyProperty.Register(nameof(VideoDurationSeconds), typeof(double), typeof(MuiPreviewSurface),
                new PropertyMetadata(0.0, (d, e) => ((MuiPreviewSurface)d)._video.DurationSeconds = (double)e.NewValue));

        public static readonly DependencyProperty ToolbarEntriesProperty =
            DependencyProperty.Register(nameof(ToolbarEntries), typeof(IReadOnlyList<MuiToolbarEntry>), typeof(MuiPreviewSurface),
                new PropertyMetadata(null, (d, e) => ((MuiPreviewSurface)d)._toolbar.Entries = (IReadOnlyList<MuiToolbarEntry>?)e.NewValue));

        public static readonly DependencyProperty FilmstripItemsProperty =
            DependencyProperty.Register(nameof(FilmstripItems), typeof(IReadOnlyList<MuiFilmstripItem>), typeof(MuiPreviewSurface),
                new PropertyMetadata(null, (d, e) => ((MuiPreviewSurface)d)._filmstrip.Items = (IReadOnlyList<MuiFilmstripItem>?)e.NewValue));

        public static readonly DependencyProperty ActiveIdProperty =
            DependencyProperty.Register(nameof(ActiveId), typeof(string), typeof(MuiPreviewSurface),
                new PropertyMetadata(null, (d, e) => ((MuiPreviewSurface)d)._filmstrip.ActiveId = (string?)e.NewValue));

        public string Title { get => (string)GetValue(TitleProperty); set => SetValue(TitleProperty, value); }
        public ImageSource? Source { get => (ImageSource?)GetValue(SourceProperty); set => SetValue(SourceProperty, value); }
        public bool IsVideo { get => (bool)GetValue(IsVideoProperty); set => SetValue(IsVideoProperty, value); }
        public ImageSource? VideoPoster { get => (ImageSource?)GetValue(VideoPosterProperty); set => SetValue(VideoPosterProperty, value); }
        public double VideoDurationSeconds { get => (double)GetValue(VideoDurationSecondsProperty); set => SetValue(VideoDurationSecondsProperty, value); }

        public IReadOnlyList<MuiToolbarEntry>? ToolbarEntries
        {
            get => (IReadOnlyList<MuiToolbarEntry>?)GetValue(ToolbarEntriesProperty);
            set => SetValue(ToolbarEntriesProperty, value);
        }

        public IReadOnlyList<MuiFilmstripItem>? FilmstripItems
        {
            get => (IReadOnlyList<MuiFilmstripItem>?)GetValue(FilmstripItemsProperty);
            set => SetValue(FilmstripItemsProperty, value);
        }

        public string? ActiveId { get => (string?)GetValue(ActiveIdProperty); set => SetValue(ActiveIdProperty, value); }

        public event EventHandler? BackRequested;
        public event EventHandler<string>? ToolbarActionSelected;
        public event EventHandler<string>? FilmstripActivated;

        private readonly Grid _root = new();
        private readonly MuiPageHeader _header = new() { ShowBack = true };
        private readonly Grid _stage = new();
        private readonly MuiPreviewImage _image = new() { Fit = MuiImageFit.Uniform };
        private readonly MuiVideoPlayer _video = new();
        private readonly MuiToolbar _toolbar = new() { HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(0, 0, 0, 12) };
        private readonly MuiFilmstrip _filmstrip = new();

        public MuiPreviewSurface()
        {
            _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
            _root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
            _root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

            _stage.Children.Add(_image);
            _stage.Children.Add(_video);
            _stage.Children.Add(_toolbar);

            Grid.SetRow(_header, 0);
            Grid.SetRow(_stage, 1);
            Grid.SetRow(_filmstrip, 2);
            _root.Children.Add(_header);
            _root.Children.Add(_stage);
            _root.Children.Add(_filmstrip);
            Content = _root;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _header.BackRequested += (_, _) => BackRequested?.Invoke(this, EventArgs.Empty);
            _toolbar.ItemSelected += (_, id) => ToolbarActionSelected?.Invoke(this, id);
            _filmstrip.Activated += (_, id) => { ActiveId = id; FilmstripActivated?.Invoke(this, id); };

            Rebuild();
        }

        private void Rebuild()
        {
            _image.Visibility = IsVideo ? Visibility.Collapsed : Visibility.Visible;
            _video.Visibility = IsVideo ? Visibility.Visible : Visibility.Collapsed;
        }
    }
}
