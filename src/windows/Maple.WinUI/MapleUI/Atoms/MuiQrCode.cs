using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Shapes;

namespace Maple.UI.Atoms
{
    /// <summary>QR Code size (unified-component-catalog.md §1.4 Media,
    /// "QR Code" row: "Sizes").</summary>
    public enum MuiQrCodeSize { Sm, Md, Lg }

    /// <summary>
    /// Maple.UI QR Code atom (unified-component-catalog.md §1.4 Media,
    /// "QR Code" row: "Renders a payload as a QR image · Sizes · Quiet zone
    /// · Contrast requirement") — a REAL, scannable QR code as of MN4
    /// (#3053): <see cref="MuiQrMatrix"/> (backed by the QRCoder package)
    /// encodes <see cref="Payload"/> into the module matrix, rendered as a
    /// module grid of vector Rectangles so it stays crisp at any display
    /// scale. The former hash-derived placeholder rendering is deleted.
    ///
    /// The quiet zone (a real code's mandatory 4-module blank margin) is
    /// drawn by this atom's own padding, and the black-on-white pairing is
    /// unconditional regardless of app theme — a scanner needs true
    /// contrast, not the dark-surface token.
    /// </summary>
    public sealed class MuiQrCode : ContentControl
    {
        public static readonly DependencyProperty PayloadProperty =
            DependencyProperty.Register(nameof(Payload), typeof(string), typeof(MuiQrCode),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiQrCode)d).Rebuild()));

        public static readonly DependencyProperty QrSizeProperty =
            DependencyProperty.Register(nameof(QrSize), typeof(MuiQrCodeSize), typeof(MuiQrCode),
                new PropertyMetadata(MuiQrCodeSize.Md, (d, _) => ((MuiQrCode)d).Rebuild()));

        public string Payload
        {
            get => (string)GetValue(PayloadProperty);
            set => SetValue(PayloadProperty, value);
        }

        public MuiQrCodeSize QrSize
        {
            get => (MuiQrCodeSize)GetValue(QrSizeProperty);
            set => SetValue(QrSizeProperty, value);
        }

        private readonly Border _quietZone = new();
        private readonly Grid _grid = new();
        private readonly List<Rectangle> _cells = new();
        private int _builtModuleCount;

        public MuiQrCode()
        {
            _quietZone.Child = _grid;
            Content = _quietZone;
            IsTabStop = false;

            Rebuild();
        }

        private static double EdgeFor(MuiQrCodeSize size) => size switch
        {
            MuiQrCodeSize.Sm => 96,
            MuiQrCodeSize.Lg => 192,
            _ => 144,
        };

        private void Rebuild()
        {
            var matrix = MuiQrMatrix.Encode(Payload);
            var moduleCount = matrix.GetLength(0);

            var edge = EdgeFor(QrSize);
            // Quiet zone: 4 modules of the full (modules + margins) span,
            // so the drawn module size stays consistent with the margin.
            var quietZonePx = edge * (4.0 / (moduleCount + 8));

            _quietZone.Width = edge;
            _quietZone.Height = edge;
            _quietZone.Padding = new Thickness(quietZonePx);
            _quietZone.CornerRadius = new CornerRadius(8);
            _quietZone.Background = new SolidColorBrush(Microsoft.UI.Colors.White);
            _grid.Width = edge - quietZonePx * 2;
            _grid.Height = edge - quietZonePx * 2;

            RebuildCells(moduleCount);

            var fill = new SolidColorBrush(Microsoft.UI.Colors.Black);
            for (var y = 0; y < moduleCount; y++)
            {
                for (var x = 0; x < moduleCount; x++)
                    _cells[y * moduleCount + x].Fill = matrix[y, x] ? fill : null;
            }

            AutomationProperties.SetName(this, "QR code");
        }

        /// <summary>The module count varies with QR version (payload
        /// length), so the row/column/cell skeleton is rebuilt whenever it
        /// changes — star-sized tracks divide the grid's explicit size
        /// evenly (a Rectangle has no intrinsic size of its own, so Auto
        /// tracks would collapse to 0).</summary>
        private void RebuildCells(int moduleCount)
        {
            if (_builtModuleCount == moduleCount)
                return;

            _grid.Children.Clear();
            _grid.RowDefinitions.Clear();
            _grid.ColumnDefinitions.Clear();
            _cells.Clear();

            for (var i = 0; i < moduleCount; i++)
            {
                _grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
                _grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            }
            for (var y = 0; y < moduleCount; y++)
            {
                for (var x = 0; x < moduleCount; x++)
                {
                    var cell = new Rectangle();
                    Grid.SetRow(cell, y);
                    Grid.SetColumn(cell, x);
                    _cells.Add(cell);
                    _grid.Children.Add(cell);
                }
            }
            _builtModuleCount = moduleCount;
        }
    }
}
