using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Drag Preview molecule (unified-component-catalog.md §2.7,
    /// "Drag Preview" row: "Ghost shown while dragging", built from Image,
    /// Badge) — a slightly rotated, reduced-opacity card shown under the
    /// cursor while dragging one or more assets, with a "+N" count badge
    /// once more than one item is being dragged.
    ///
    /// Purely presentational, per `mui-drag-preview.component.ts`'s own
    /// scope note: the actual drag-and-drop wiring lives at the app layer
    /// and supplies this control's <see cref="Source"/>/<see cref="Count"/>
    /// — hence <see cref="UIElement.IsHitTestVisible"/> is off, matching a
    /// real drag ghost that must never itself become a drop target.
    /// </summary>
    public sealed class MuiDragPreview : ContentControl
    {
        public static readonly DependencyProperty SourceProperty =
            DependencyProperty.Register(nameof(Source), typeof(ImageSource), typeof(MuiDragPreview),
                new PropertyMetadata(null, (d, _) => ((MuiDragPreview)d).Rebuild()));

        public static readonly DependencyProperty AccessibleLabelProperty =
            DependencyProperty.Register(nameof(AccessibleLabel), typeof(string), typeof(MuiDragPreview),
                new PropertyMetadata("Dragged item", (d, _) => ((MuiDragPreview)d).Rebuild()));

        public static readonly DependencyProperty CountProperty =
            DependencyProperty.Register(nameof(Count), typeof(int), typeof(MuiDragPreview),
                new PropertyMetadata(1, (d, _) => ((MuiDragPreview)d).Rebuild()));

        public static readonly DependencyProperty PreviewSizeProperty =
            DependencyProperty.Register(nameof(PreviewSize), typeof(double), typeof(MuiDragPreview),
                new PropertyMetadata(72.0, (d, _) => ((MuiDragPreview)d).Rebuild()));

        public ImageSource? Source
        {
            get => (ImageSource?)GetValue(SourceProperty);
            set => SetValue(SourceProperty, value);
        }

        public string AccessibleLabel
        {
            get => (string)GetValue(AccessibleLabelProperty);
            set => SetValue(AccessibleLabelProperty, value);
        }

        /// <summary>Total items being dragged; a badge appears once this is
        /// greater than 1.</summary>
        public int Count
        {
            get => (int)GetValue(CountProperty);
            set => SetValue(CountProperty, value);
        }

        public double PreviewSize
        {
            get => (double)GetValue(PreviewSizeProperty);
            set => SetValue(PreviewSizeProperty, value);
        }

        private readonly Grid _outer = new();
        private readonly Border _card = new()
        {
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(10),
            Opacity = 0.85,
            RenderTransform = new RotateTransform { Angle = -6 },
        };
        private readonly Image _image = new() { Stretch = Stretch.UniformToFill };
        private readonly MuiBadge _countBadge = new()
        {
            Variant = MuiBadgeVariant.Count,
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(0, -8, -8, 0),
        };

        public MuiDragPreview()
        {
            _card.Child = _image;
            _outer.Children.Add(_card);
            _outer.Children.Add(_countBadge);
            Content = _outer;
            IsTabStop = false;
            IsHitTestVisible = false;

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Rebuild()
        {
            _card.Width = PreviewSize;
            _card.Height = PreviewSize;
            _card.Background = R("MapleSurfaceAlt");
            _card.BorderBrush = R("MapleBorder");

            _image.Source = Source;

            _countBadge.Value = "+" + (Count - 1);
            _countBadge.Label = Count + " items";
            _countBadge.Visibility = Count > 1 ? Visibility.Visible : Visibility.Collapsed;

            if (!string.IsNullOrEmpty(AccessibleLabel))
                AutomationProperties.SetName(this, AccessibleLabel);
        }
    }
}
