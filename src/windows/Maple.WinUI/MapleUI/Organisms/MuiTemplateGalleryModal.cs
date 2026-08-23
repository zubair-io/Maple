using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One browsable template.</summary>
    public sealed record MuiGalleryTemplate(string Id, string Title, string? Subtitle = null, ImageSource? Preview = null);

    /// <summary>
    /// Maple.UI Template Gallery modal organism (unified-component-catalog.md
    /// §4.4, "Template Gallery" row: "Browse and apply templates", built
    /// from Card, Search Bar, Empty State) — a <see cref="MuiSearchBar"/>
    /// filters a wrapped grid of <see cref="MuiCard"/>s, or a
    /// <see cref="MuiEmptyState"/> when nothing matches.
    /// </summary>
    public sealed class MuiTemplateGalleryModal : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiTemplateGalleryModal),
                new PropertyMetadata(false, (d, e) => ((MuiTemplateGalleryModal)d)._shell.IsOpen = (bool)e.NewValue));

        public static readonly DependencyProperty ContainedProperty =
            DependencyProperty.Register(nameof(Contained), typeof(bool), typeof(MuiTemplateGalleryModal),
                new PropertyMetadata(false, (d, e) => ((MuiTemplateGalleryModal)d)._shell.Contained = (bool)e.NewValue));

        public static readonly DependencyProperty TemplatesProperty =
            DependencyProperty.Register(nameof(Templates), typeof(IReadOnlyList<MuiGalleryTemplate>), typeof(MuiTemplateGalleryModal),
                new PropertyMetadata(null, (d, _) => ((MuiTemplateGalleryModal)d).Rebuild()));

        public bool IsOpen { get => (bool)GetValue(IsOpenProperty); set => SetValue(IsOpenProperty, value); }
        public bool Contained { get => (bool)GetValue(ContainedProperty); set => SetValue(ContainedProperty, value); }

        public IReadOnlyList<MuiGalleryTemplate>? Templates
        {
            get => (IReadOnlyList<MuiGalleryTemplate>?)GetValue(TemplatesProperty);
            set => SetValue(TemplatesProperty, value);
        }

        public event EventHandler? Dismissed;
        public event EventHandler<string>? TemplateApplied;

        private readonly MuiOverlayShell _shell = new() { Size = MuiOverlayShellSize.Lg, AriaLabel = "Template Gallery" };
        private readonly MuiSearchBar _search = new() { Placeholder = "Search templates…" };
        private readonly StackPanel _rows = new() { Orientation = Orientation.Vertical, Spacing = 10 };
        private readonly MuiEmptyState _empty = new() { IconName = "grid-lg", Title = "No templates match" };
        private readonly MuiButton _close = new() { Variant = MuiButtonVariant.Ghost, Label = "Close" };
        private string _filter = string.Empty;

        public MuiTemplateGalleryModal()
        {
            var body = new StackPanel { Orientation = Orientation.Vertical, Spacing = 14 };
            body.Children.Add(_search);
            body.Children.Add(_rows);
            body.Children.Add(_empty);

            var footer = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
            footer.Children.Add(_close);

            _shell.Header = new MuiText { Text = "Template Gallery", Variant = MuiTextVariant.SheetTitle };
            _shell.Body = body;
            _shell.Footer = footer;
            Content = _shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _shell.Dismissed += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _close.Click += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _search.Committed += (_, text) => { _filter = text; Rebuild(); };

            Rebuild();
        }

        private void Rebuild()
        {
            var matches = (Templates ?? Array.Empty<MuiGalleryTemplate>())
                .Where(t => string.IsNullOrEmpty(_filter) || t.Title.Contains(_filter, StringComparison.OrdinalIgnoreCase))
                .ToList();

            _empty.Visibility = matches.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            _rows.Visibility = matches.Count > 0 ? Visibility.Visible : Visibility.Collapsed;

            _rows.Children.Clear();
            const int perRow = 3;
            StackPanel? row = null;
            for (var i = 0; i < matches.Count; i++)
            {
                if (i % perRow == 0)
                {
                    row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 10 };
                    _rows.Children.Add(row);
                }
                var template = matches[i];
                var card = new MuiCard { Title = template.Title, Subtitle = template.Subtitle, Source = template.Preview, Width = 140 };
                card.Pressed += (_, _) => TemplateApplied?.Invoke(this, template.Id);
                row!.Children.Add(card);
            }
        }
    }
}
