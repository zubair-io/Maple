using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using Windows.Foundation;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One freehand stroke, as a flat list of points in canvas
    /// coordinates.</summary>
    public sealed record MuiWhiteboardStroke(IReadOnlyList<Point> Points);

    /// <summary>
    /// Maple.UI Whiteboard Canvas organism (unified-component-catalog.md
    /// §4.5, "Whiteboard Canvas" row: "Freeform canvas with AI prompt",
    /// built from Canvas Surface, Toolbar, Command Menu) — a
    /// <see cref="MuiCanvasSurface"/> hosting a plain
    /// <see cref="Microsoft.UI.Xaml.Controls.Canvas"/> of
    /// <see cref="Polyline"/>s (this wave's brief calls for exactly that:
    /// "stroke capture via pointer events onto a Canvas of Polylines",
    /// not a bespoke ink/vector model), a <see cref="MuiToolbar"/>
    /// (Pen/Eraser/Clear), and an AI prompt row (Input + Send) that opens
    /// a <see cref="MuiCommandMenu"/> of quick prompts.
    /// </summary>
    public sealed class MuiWhiteboardCanvas : ContentControl
    {
        public static readonly DependencyProperty StrokesProperty =
            DependencyProperty.Register(nameof(Strokes), typeof(IReadOnlyList<MuiWhiteboardStroke>), typeof(MuiWhiteboardCanvas),
                new PropertyMetadata(null, (d, _) => ((MuiWhiteboardCanvas)d).RebuildStrokes()));

        public static readonly DependencyProperty IsErasingProperty =
            DependencyProperty.Register(nameof(IsErasing), typeof(bool), typeof(MuiWhiteboardCanvas),
                new PropertyMetadata(false));

        public IReadOnlyList<MuiWhiteboardStroke>? Strokes
        {
            get => (IReadOnlyList<MuiWhiteboardStroke>?)GetValue(StrokesProperty);
            set => SetValue(StrokesProperty, value);
        }

        public bool IsErasing { get => (bool)GetValue(IsErasingProperty); set => SetValue(IsErasingProperty, value); }

        public event EventHandler<IReadOnlyList<MuiWhiteboardStroke>>? StrokesChanged;
        public event EventHandler<string>? PromptSubmitted;
        public event EventHandler<string>? QuickPromptSelected;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 10 };
        private readonly MuiToolbar _toolbar = new()
        {
            Entries = new[]
            {
                MuiToolbarEntry.For(new MuiToolbarItem("pen", "edit", "Pen")),
                MuiToolbarEntry.For(new MuiToolbarItem("eraser", "clear-circle-fill", "Eraser")),
                MuiToolbarEntry.Divider(),
                MuiToolbarEntry.For(new MuiToolbarItem("clear", "x", "Clear")),
            },
        };
        private readonly MuiCanvasSurface _surface = new() { MinHeight = 260 };
        private readonly Canvas _canvas = new() { Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent) };
        private readonly List<Polyline> _polylines = new();
        private readonly Grid _promptAnchor = new();
        private readonly StackPanel _promptRow = new() { Orientation = Orientation.Horizontal, Spacing = 8 };
        private readonly MuiInput _prompt = new() { Placeholder = "Ask AI to draw or enhance…" };
        private readonly MuiButton _promptMenuButton = new() { Variant = MuiButtonVariant.Ghost, Label = "Quick prompts" };
        private readonly MuiButton _send = new() { Variant = MuiButtonVariant.Primary, Label = "Send" };
        private readonly MuiCommandMenu _quickPrompts = new()
        {
            Commands = new[]
            {
                new MuiCommandItem("cleanup", "Clean up my sketch"),
                new MuiCommandItem("colorize", "Colorize this"),
                new MuiCommandItem("describe", "Describe what I drew"),
            },
        };

        private Polyline? _activeStroke;

        public MuiWhiteboardCanvas()
        {
            _surface.HostedContent = _canvas;
            _promptRow.Children.Add(_prompt);
            _promptRow.Children.Add(_promptMenuButton);
            _promptRow.Children.Add(_send);
            _promptAnchor.Children.Add(_promptRow);
            _promptAnchor.Children.Add(_quickPrompts);

            _root.Children.Add(_toolbar);
            _root.Children.Add(_surface);
            _root.Children.Add(_promptAnchor);
            Content = _root;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;

            _toolbar.ItemSelected += OnToolbarItemSelected;
            _canvas.PointerPressed += OnCanvasPointerPressed;
            _canvas.PointerMoved += OnCanvasPointerMoved;
            _canvas.PointerReleased += (_, _) => CommitActiveStroke();
            _promptMenuButton.Click += (_, _) => _quickPrompts.IsOpen = true;
            _quickPrompts.ItemSelected += (_, id) => { _quickPrompts.IsOpen = false; QuickPromptSelected?.Invoke(this, id); };
            _quickPrompts.CloseRequested += (_, _) => _quickPrompts.IsOpen = false;
            _send.Click += (_, _) => { if (!string.IsNullOrWhiteSpace(_prompt.Text)) { PromptSubmitted?.Invoke(this, _prompt.Text); _prompt.Text = string.Empty; } };

            RebuildStrokes();
        }

        private void OnToolbarItemSelected(object? sender, string id)
        {
            if (id == "clear")
            {
                _polylines.Clear();
                _canvas.Children.Clear();
                StrokesChanged?.Invoke(this, Array.Empty<MuiWhiteboardStroke>());
            }
            else
            {
                IsErasing = id == "eraser";
            }
        }

        private void OnCanvasPointerPressed(object sender, PointerRoutedEventArgs e)
        {
            var pos = e.GetCurrentPoint(_canvas).Position;
            if (IsErasing)
            {
                EraseNear(pos);
                return;
            }

            _activeStroke = new Polyline
            {
                Stroke = (Brush)Application.Current.Resources["MaplePrimary"],
                StrokeThickness = 3,
                StrokeLineJoin = PenLineJoin.Round,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round,
            };
            _activeStroke.Points.Add(pos);
            _canvas.Children.Add(_activeStroke);
        }

        private void OnCanvasPointerMoved(object sender, PointerRoutedEventArgs e)
        {
            var pos = e.GetCurrentPoint(_canvas).Position;
            if (IsErasing)
            {
                if (e.GetCurrentPoint(_canvas).Properties.IsLeftButtonPressed) EraseNear(pos);
                return;
            }
            _activeStroke?.Points.Add(pos);
        }

        private void EraseNear(Point pos)
        {
            const double threshold = 12;
            var hit = _polylines.FirstOrDefault(p => p.Points.Any(pt => Distance(pt, pos) < threshold));
            if (hit is null) return;
            _polylines.Remove(hit);
            _canvas.Children.Remove(hit);
            StrokesChanged?.Invoke(this, _polylines.Select(ToStroke).ToList());
        }

        private static double Distance(Point a, Point b)
        {
            var dx = a.X - b.X;
            var dy = a.Y - b.Y;
            return Math.Sqrt(dx * dx + dy * dy);
        }

        private void CommitActiveStroke()
        {
            if (_activeStroke is null) return;
            _polylines.Add(_activeStroke);
            _activeStroke = null;
            StrokesChanged?.Invoke(this, _polylines.Select(ToStroke).ToList());
        }

        private static MuiWhiteboardStroke ToStroke(Polyline polyline) => new(polyline.Points.ToList());

        private void RebuildStrokes()
        {
            _canvas.Children.Clear();
            _polylines.Clear();
            foreach (var stroke in Strokes ?? Array.Empty<MuiWhiteboardStroke>())
            {
                var polyline = new Polyline
                {
                    Stroke = (Brush)Application.Current.Resources["MaplePrimary"],
                    StrokeThickness = 3,
                    StrokeLineJoin = PenLineJoin.Round,
                };
                foreach (var point in stroke.Points) polyline.Points.Add(point);
                _polylines.Add(polyline);
                _canvas.Children.Add(polyline);
            }
        }
    }
}
