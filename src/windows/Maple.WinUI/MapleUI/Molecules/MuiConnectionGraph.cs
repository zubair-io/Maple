using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Connection Graph data plot (unified-component-catalog.md
    /// §2.6, "Connection Graph" row: "Node-link graph", built from _(plot
    /// primitive)_) — a STATIC (force-free) node-link graph: the caller
    /// supplies each node's normalized (0..1) position via
    /// <see cref="MuiConnectionGraphMath"/>; this control only draws links,
    /// node dots, and labels. Draws each node's dot and (if
    /// <see cref="ShowLabels"/>) its label immediately after, so a later
    /// node's dot can never paint over an earlier node's label — matches
    /// `mui-connection-graph.component.ts`'s own single dot+label pass per
    /// node rather than batching all dots before all labels.
    /// </summary>
    public sealed class MuiConnectionGraph : ContentControl
    {
        public static readonly DependencyProperty NodesProperty =
            DependencyProperty.Register(nameof(Nodes), typeof(IReadOnlyList<MuiConnectionGraphNode>), typeof(MuiConnectionGraph),
                new PropertyMetadata(null, (d, _) => ((MuiConnectionGraph)d).Render()));

        public static readonly DependencyProperty LinksProperty =
            DependencyProperty.Register(nameof(Links), typeof(IReadOnlyList<MuiConnectionGraphLink>), typeof(MuiConnectionGraph),
                new PropertyMetadata(null, (d, _) => ((MuiConnectionGraph)d).Render()));

        public static readonly DependencyProperty ShowLabelsProperty =
            DependencyProperty.Register(nameof(ShowLabels), typeof(bool), typeof(MuiConnectionGraph),
                new PropertyMetadata(true, (d, _) => ((MuiConnectionGraph)d).Render()));

        public static readonly DependencyProperty PlotWidthProperty =
            DependencyProperty.Register(nameof(PlotWidth), typeof(double), typeof(MuiConnectionGraph),
                new PropertyMetadata(160.0, (d, _) => ((MuiConnectionGraph)d).Rebuild()));

        public static readonly DependencyProperty PlotHeightProperty =
            DependencyProperty.Register(nameof(PlotHeight), typeof(double), typeof(MuiConnectionGraph),
                new PropertyMetadata(96.0, (d, _) => ((MuiConnectionGraph)d).Rebuild()));

        public IReadOnlyList<MuiConnectionGraphNode>? Nodes
        {
            get => (IReadOnlyList<MuiConnectionGraphNode>?)GetValue(NodesProperty);
            set => SetValue(NodesProperty, value);
        }

        public IReadOnlyList<MuiConnectionGraphLink>? Links
        {
            get => (IReadOnlyList<MuiConnectionGraphLink>?)GetValue(LinksProperty);
            set => SetValue(LinksProperty, value);
        }

        public bool ShowLabels
        {
            get => (bool)GetValue(ShowLabelsProperty);
            set => SetValue(ShowLabelsProperty, value);
        }

        public double PlotWidth
        {
            get => (double)GetValue(PlotWidthProperty);
            set => SetValue(PlotWidthProperty, value);
        }

        public double PlotHeight
        {
            get => (double)GetValue(PlotHeightProperty);
            set => SetValue(PlotHeightProperty, value);
        }

        private readonly Grid _frame = new() { CornerRadius = new CornerRadius(6), BorderThickness = new Thickness(0.5) };
        private readonly Canvas _canvas = new();

        public MuiConnectionGraph()
        {
            _frame.Children.Add(_canvas);
            Content = _frame;
            IsTabStop = false;

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            _frame.Width = PlotWidth;
            _frame.Height = PlotHeight;
            _canvas.Width = PlotWidth;
            _canvas.Height = PlotHeight;
            _frame.Background = R("MapleImageCanvas");
            _frame.BorderBrush = R("MapleBorder");
            Render();
        }

        private void Render()
        {
            _canvas.Children.Clear();
            var w = PlotWidth;
            var h = PlotHeight;
            if (w <= 0 || h <= 0) return;

            var nodes = Nodes ?? Array.Empty<MuiConnectionGraphNode>();
            var nodesById = MuiConnectionGraphMath.IndexById(nodes);

            var lineBrush = R("MapleBorder");
            foreach (var link in Links ?? Array.Empty<MuiConnectionGraphLink>())
            {
                if (!nodesById.TryGetValue(link.Source, out var source)) continue;
                if (!nodesById.TryGetValue(link.Target, out var target)) continue;

                var a = MuiConnectionGraphMath.ToPixel(source, w, h);
                var b = MuiConnectionGraphMath.ToPixel(target, w, h);
                _canvas.Children.Add(new Line { X1 = a.X, Y1 = a.Y, X2 = b.X, Y2 = b.Y, Stroke = lineBrush, StrokeThickness = 1.5 });
            }

            var accent = R("MaplePrimary");
            var textColor = R("MapleTextMain");
            var showLabels = ShowLabels;
            foreach (var node in nodes)
            {
                var p = MuiConnectionGraphMath.ToPixel(node, w, h);

                var dot = new Ellipse { Width = 10, Height = 10, Fill = accent };
                Canvas.SetLeft(dot, p.X - 5);
                Canvas.SetTop(dot, p.Y - 5);
                _canvas.Children.Add(dot);

                if (!showLabels) continue;
                var label = new TextBlock
                {
                    Text = node.Label,
                    FontSize = 11,
                    Foreground = textColor,
                    Width = 48,
                    TextAlignment = TextAlignment.Center,
                    TextTrimming = TextTrimming.CharacterEllipsis,
                };
                Canvas.SetLeft(label, p.X - 24);
                Canvas.SetTop(label, p.Y + 7);
                _canvas.Children.Add(label);
            }
        }
    }
}
