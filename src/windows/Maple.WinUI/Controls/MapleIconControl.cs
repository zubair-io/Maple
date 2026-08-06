using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Markup;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;
using XamlPath = Microsoft.UI.Xaml.Shapes.Path;

namespace Maple.WinUI.Controls
{
    /// <summary>
    /// Renders one icon of the shared Maple stroke family (MapleIconShapes) —
    /// the Windows sibling of the web MapleIconComponent and Apple's
    /// ToolGlyphShapes renderer: 16×16 viewBox scaled to Size, round caps and
    /// joins, stroke-only unless a shape is marked Filled, color from
    /// IconBrush (defaults to the inherited Foreground).
    /// </summary>
    public sealed class MapleIconControl : ContentControl
    {
        public static readonly DependencyProperty IconNameProperty =
            DependencyProperty.Register(nameof(IconName), typeof(string), typeof(MapleIconControl),
                new PropertyMetadata(string.Empty, (d, _) => ((MapleIconControl)d).Rebuild()));

        public static readonly DependencyProperty SizeProperty =
            DependencyProperty.Register(nameof(Size), typeof(double), typeof(MapleIconControl),
                new PropertyMetadata(14.0, (d, _) => ((MapleIconControl)d).Rebuild()));

        public static readonly DependencyProperty IconBrushProperty =
            DependencyProperty.Register(nameof(IconBrush), typeof(Brush), typeof(MapleIconControl),
                new PropertyMetadata(null, (d, _) => ((MapleIconControl)d).Rebuild()));

        public string IconName
        {
            get => (string)GetValue(IconNameProperty);
            set => SetValue(IconNameProperty, value);
        }

        public double Size
        {
            get => (double)GetValue(SizeProperty);
            set => SetValue(SizeProperty, value);
        }

        public Brush? IconBrush
        {
            get => (Brush?)GetValue(IconBrushProperty);
            set => SetValue(IconBrushProperty, value);
        }

        public MapleIconControl()
        {
            IsTabStop = false;
            Rebuild();
        }

        private void Rebuild()
        {
            var brush = IconBrush ?? Foreground;
            Content = string.IsNullOrEmpty(IconName)
                ? null
                : Build(IconName, Size, brush);
        }

        /// <summary>Chrome-set default stroke; tool glyphs carry their own 1.6
        /// in the shape table (the S5 drawing contract).</summary>
        public const double DefaultStrokeWidth = 1.5;

        /// <summary>Code-behind builder (rail pills, star rows) — same drawing
        /// the control produces.</summary>
        public static Viewbox Build(string name, double size, Brush stroke)
        {
            var canvas = new Canvas { Width = 16, Height = 16 };
            if (MapleIconShapes.Shapes.TryGetValue(name, out var shapes))
            {
                foreach (var shape in shapes)
                    canvas.Children.Add(Render(shape, stroke));
            }
            return new Viewbox { Width = size, Height = size, Child = canvas };
        }

        private static Shape Render(IconShape shape, Brush color)
        {
            var strokeWidth = shape.StrokeWidth ?? DefaultStrokeWidth;
            Shape element;
            if (shape.PathData != null)
            {
                element = new XamlPath
                {
                    Data = (Geometry)XamlBindingHelper.ConvertValue(typeof(Geometry), shape.PathData),
                };
            }
            else if (shape.Circle is { } circle)
            {
                element = new XamlPath
                {
                    Data = new EllipseGeometry
                    {
                        Center = new Windows.Foundation.Point(circle.Cx, circle.Cy),
                        RadiusX = circle.R,
                        RadiusY = circle.R,
                    },
                };
            }
            else if (shape.Rect is { } rect)
            {
                var rectangle = new Rectangle
                {
                    Width = rect.W,
                    Height = rect.H,
                    RadiusX = rect.Rx,
                    RadiusY = rect.Rx,
                };
                Canvas.SetLeft(rectangle, rect.X);
                Canvas.SetTop(rectangle, rect.Y);
                element = rectangle;
            }
            else
            {
                throw new InvalidOperationException("empty icon shape");
            }

            if (shape.Filled)
            {
                element.Fill = color;
            }
            else
            {
                element.Stroke = color;
                element.StrokeThickness = strokeWidth;
                element.StrokeStartLineCap = PenLineCap.Round;
                element.StrokeEndLineCap = PenLineCap.Round;
                element.StrokeLineJoin = PenLineJoin.Round;
            }
            element.Opacity = shape.Opacity;
            return element;
        }
    }
}
