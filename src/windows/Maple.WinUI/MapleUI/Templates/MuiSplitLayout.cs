using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Split Layout template (unified-component-catalog.md §5,
    /// "Split Layout" row: "Sidebar · Center · Detail", regions only) —
    /// backs the Browse, Editor, Document, and Chat pages (§6). Ports
    /// `mui-split-layout.component.ts`'s contract: Sidebar and Detail are
    /// draggable-resizable (pointer-capture drag on a plain
    /// <see cref="Border"/> handle between regions, clamped to their
    /// min/max width properties — same "PointerPressed → CapturePointer →
    /// PointerMoved/PointerReleased on the same element" shape
    /// <see cref="MuiDragBar"/> already uses in this library),
    /// and collapse order at narrow widths follows
    /// <see cref="MuiSplitLayoutMath"/>: Detail collapses first (the most
    /// dispensable region — an inspector or thread panel), then Sidebar,
    /// leaving Center full-width on a phone.
    ///
    /// Width comes from this control's own <see cref="FrameworkElement.SizeChanged"/>
    /// rather than a horizontal size class — collapse needs two
    /// independent thresholds (900px then 640px), which only measuring the
    /// actual host width can reproduce. The pure decision math lives in
    /// <see cref="MuiSplitLayoutMath"/> so it's unit-testable without a
    /// live Window.
    ///
    /// The visual tree is only rebuilt (<see cref="UpdateStructure"/>) when
    /// which regions/handles are PRESENT changes — a live width drag only
    /// ever updates a stored <see cref="ColumnDefinition"/>'s
    /// <see cref="ColumnDefinition.Width"/> directly
    /// (<see cref="ApplySidebarWidth"/>/<see cref="ApplyDetailWidth"/>),
    /// never touches <c>Children</c>. Removing a handle from the visual
    /// tree mid-drag (as a full rebuild-every-pointer-move would do) would
    /// drop its active pointer capture.
    /// </summary>
    public sealed class MuiSplitLayout : ContentControl
    {
        public static readonly DependencyProperty SidebarProperty =
            DependencyProperty.Register(nameof(Sidebar), typeof(UIElement), typeof(MuiSplitLayout),
                new PropertyMetadata(null, (d, _) => ((MuiSplitLayout)d).Rebuild()));

        public static readonly DependencyProperty CenterProperty =
            DependencyProperty.Register(nameof(Center), typeof(UIElement), typeof(MuiSplitLayout),
                new PropertyMetadata(null, (d, _) => ((MuiSplitLayout)d).Rebuild()));

        public static readonly DependencyProperty DetailProperty =
            DependencyProperty.Register(nameof(Detail), typeof(UIElement), typeof(MuiSplitLayout),
                new PropertyMetadata(null, (d, _) => ((MuiSplitLayout)d).Rebuild()));

        public static readonly DependencyProperty SidebarWidthProperty =
            DependencyProperty.Register(nameof(SidebarWidth), typeof(double), typeof(MuiSplitLayout),
                new PropertyMetadata(260.0, (d, _) => ((MuiSplitLayout)d).ApplySidebarWidth()));

        public static readonly DependencyProperty SidebarMinProperty =
            DependencyProperty.Register(nameof(SidebarMin), typeof(double), typeof(MuiSplitLayout),
                new PropertyMetadata(200.0));

        public static readonly DependencyProperty SidebarMaxProperty =
            DependencyProperty.Register(nameof(SidebarMax), typeof(double), typeof(MuiSplitLayout),
                new PropertyMetadata(400.0));

        public static readonly DependencyProperty ShowDetailProperty =
            DependencyProperty.Register(nameof(ShowDetail), typeof(bool), typeof(MuiSplitLayout),
                new PropertyMetadata(true, (d, _) => ((MuiSplitLayout)d).UpdateStructure()));

        public static readonly DependencyProperty DetailWidthProperty =
            DependencyProperty.Register(nameof(DetailWidth), typeof(double), typeof(MuiSplitLayout),
                new PropertyMetadata(320.0, (d, _) => ((MuiSplitLayout)d).ApplyDetailWidth()));

        public static readonly DependencyProperty DetailMinProperty =
            DependencyProperty.Register(nameof(DetailMin), typeof(double), typeof(MuiSplitLayout),
                new PropertyMetadata(240.0));

        public static readonly DependencyProperty DetailMaxProperty =
            DependencyProperty.Register(nameof(DetailMax), typeof(double), typeof(MuiSplitLayout),
                new PropertyMetadata(480.0));

        /// <summary>Set false to keep every region rendered regardless of
        /// host width — an escape hatch for embedding a miniature/preview
        /// instance (e.g. a design-showcase gallery card) narrower than
        /// the collapse breakpoints without it losing regions.</summary>
        public static readonly DependencyProperty CollapseEnabledProperty =
            DependencyProperty.Register(nameof(CollapseEnabled), typeof(bool), typeof(MuiSplitLayout),
                new PropertyMetadata(true, (d, _) => ((MuiSplitLayout)d).UpdateStructure()));

        public UIElement? Sidebar { get => (UIElement?)GetValue(SidebarProperty); set => SetValue(SidebarProperty, value); }
        public UIElement? Center { get => (UIElement?)GetValue(CenterProperty); set => SetValue(CenterProperty, value); }
        public UIElement? Detail { get => (UIElement?)GetValue(DetailProperty); set => SetValue(DetailProperty, value); }

        public double SidebarWidth { get => (double)GetValue(SidebarWidthProperty); set => SetValue(SidebarWidthProperty, value); }
        public double SidebarMin { get => (double)GetValue(SidebarMinProperty); set => SetValue(SidebarMinProperty, value); }
        public double SidebarMax { get => (double)GetValue(SidebarMaxProperty); set => SetValue(SidebarMaxProperty, value); }

        public bool ShowDetail { get => (bool)GetValue(ShowDetailProperty); set => SetValue(ShowDetailProperty, value); }
        public double DetailWidth { get => (double)GetValue(DetailWidthProperty); set => SetValue(DetailWidthProperty, value); }
        public double DetailMin { get => (double)GetValue(DetailMinProperty); set => SetValue(DetailMinProperty, value); }
        public double DetailMax { get => (double)GetValue(DetailMaxProperty); set => SetValue(DetailMaxProperty, value); }

        public bool CollapseEnabled { get => (bool)GetValue(CollapseEnabledProperty); set => SetValue(CollapseEnabledProperty, value); }

        /// <summary>Fires after a Sidebar handle drag.</summary>
        public event EventHandler<double>? SidebarWidthChanged;

        /// <summary>Fires after a Detail handle drag.</summary>
        public event EventHandler<double>? DetailWidthChanged;

        private readonly Grid _root = new();
        private readonly Grid _sidebarSlot = new();
        private readonly Grid _centerSlot = new();
        private readonly Grid _detailSlot = new();
        private readonly Border _sidebarHandle = new() { Width = 6 };
        private readonly Border _detailHandle = new() { Width = 6 };

        private ColumnDefinition? _sidebarColumn;
        private ColumnDefinition? _detailColumn;
        private bool? _sidebarCollapsedState;
        private bool? _detailCollapsedState;

        /// <summary>Defaults wide (no collapse) until the first
        /// SizeChanged callback lands — avoids a flash-collapse before
        /// this control has ever been measured.</summary>
        private double _hostWidth = double.PositiveInfinity;

        private uint? _sidebarPointerId;
        private double _sidebarDragStartX;
        private double _sidebarDragStartWidth;

        private uint? _detailPointerId;
        private double _detailDragStartX;
        private double _detailDragStartWidth;

        public MuiSplitLayout()
        {
            _sidebarHandle.PointerPressed += OnSidebarHandlePointerPressed;
            _sidebarHandle.PointerMoved += OnSidebarHandlePointerMoved;
            _sidebarHandle.PointerReleased += OnSidebarHandlePointerReleased;
            _sidebarHandle.PointerCanceled += OnSidebarHandlePointerReleased;
            _sidebarHandle.PointerCaptureLost += (_, _) => _sidebarPointerId = null;

            _detailHandle.PointerPressed += OnDetailHandlePointerPressed;
            _detailHandle.PointerMoved += OnDetailHandlePointerMoved;
            _detailHandle.PointerReleased += OnDetailHandlePointerReleased;
            _detailHandle.PointerCanceled += OnDetailHandlePointerReleased;
            _detailHandle.PointerCaptureLost += (_, _) => _detailPointerId = null;

            AutomationProperties.SetName(_sidebarHandle, "Resize sidebar");
            AutomationProperties.SetName(_detailHandle, "Resize detail");

            Content = _root;
            IsTabStop = false;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            SizeChanged += (_, e) => { _hostWidth = e.NewSize.Width; UpdateStructure(); };

            Rebuild();
            UpdateStructure();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void OnSidebarHandlePointerPressed(object sender, PointerRoutedEventArgs e)
        {
            if (!e.GetCurrentPoint(_sidebarHandle).Properties.IsLeftButtonPressed) return;
            _sidebarPointerId = e.Pointer.PointerId;
            _sidebarDragStartX = e.GetCurrentPoint(this).Position.X;
            _sidebarDragStartWidth = SidebarWidth;
            _sidebarHandle.CapturePointer(e.Pointer);
            e.Handled = true;
        }

        private void OnSidebarHandlePointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (_sidebarPointerId != e.Pointer.PointerId) return;
            var dx = e.GetCurrentPoint(this).Position.X - _sidebarDragStartX;
            SidebarWidth = MuiSplitLayoutMath.Clamp(_sidebarDragStartWidth + dx, SidebarMin, SidebarMax);
            SidebarWidthChanged?.Invoke(this, SidebarWidth);
            e.Handled = true;
        }

        private void OnSidebarHandlePointerReleased(object sender, PointerRoutedEventArgs e)
        {
            if (_sidebarPointerId != e.Pointer.PointerId) return;
            _sidebarPointerId = null;
            _sidebarHandle.ReleasePointerCapture(e.Pointer);
            e.Handled = true;
        }

        private void OnDetailHandlePointerPressed(object sender, PointerRoutedEventArgs e)
        {
            if (!e.GetCurrentPoint(_detailHandle).Properties.IsLeftButtonPressed) return;
            _detailPointerId = e.Pointer.PointerId;
            _detailDragStartX = e.GetCurrentPoint(this).Position.X;
            _detailDragStartWidth = DetailWidth;
            _detailHandle.CapturePointer(e.Pointer);
            e.Handled = true;
        }

        private void OnDetailHandlePointerMoved(object sender, PointerRoutedEventArgs e)
        {
            if (_detailPointerId != e.Pointer.PointerId) return;
            // Detail sits to the right of its handle, so dragging left
            // grows it — invert the delta relative to the Sidebar handle.
            var dx = e.GetCurrentPoint(this).Position.X - _detailDragStartX;
            DetailWidth = MuiSplitLayoutMath.Clamp(_detailDragStartWidth - dx, DetailMin, DetailMax);
            DetailWidthChanged?.Invoke(this, DetailWidth);
            e.Handled = true;
        }

        private void OnDetailHandlePointerReleased(object sender, PointerRoutedEventArgs e)
        {
            if (_detailPointerId != e.Pointer.PointerId) return;
            _detailPointerId = null;
            _detailHandle.ReleasePointerCapture(e.Pointer);
            e.Handled = true;
        }

        private void ApplySidebarWidth()
        {
            if (_sidebarColumn is not null) _sidebarColumn.Width = new GridLength(SidebarWidth);
        }

        private void ApplyDetailWidth()
        {
            if (_detailColumn is not null) _detailColumn.Width = new GridLength(DetailWidth);
        }

        /// <summary>Rebuilds which regions/handles are present. Only
        /// called when the collapsed state actually changes — see the
        /// class doc comment for why width drags must never reach this
        /// method.</summary>
        private void UpdateStructure()
        {
            var sidebarCollapsed = MuiSplitLayoutMath.SidebarCollapsed(_hostWidth, CollapseEnabled);
            var detailCollapsed = MuiSplitLayoutMath.DetailCollapsed(ShowDetail, _hostWidth, CollapseEnabled);
            if (sidebarCollapsed == _sidebarCollapsedState && detailCollapsed == _detailCollapsedState)
                return;
            _sidebarCollapsedState = sidebarCollapsed;
            _detailCollapsedState = detailCollapsed;

            _root.Children.Clear();
            _root.ColumnDefinitions.Clear();
            _sidebarColumn = null;
            _detailColumn = null;

            var col = 0;
            if (!sidebarCollapsed)
            {
                _sidebarColumn = new ColumnDefinition { Width = new GridLength(SidebarWidth) };
                _root.ColumnDefinitions.Add(_sidebarColumn);
                Grid.SetColumn(_sidebarSlot, col);
                _root.Children.Add(_sidebarSlot);
                col++;

                _root.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                Grid.SetColumn(_sidebarHandle, col);
                _root.Children.Add(_sidebarHandle);
                col++;
            }

            _root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            Grid.SetColumn(_centerSlot, col);
            _root.Children.Add(_centerSlot);
            col++;

            if (!detailCollapsed)
            {
                _root.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
                Grid.SetColumn(_detailHandle, col);
                _root.Children.Add(_detailHandle);
                col++;

                _detailColumn = new ColumnDefinition { Width = new GridLength(DetailWidth) };
                _root.ColumnDefinitions.Add(_detailColumn);
                Grid.SetColumn(_detailSlot, col);
                _root.Children.Add(_detailSlot);
            }
        }

        private void Rebuild()
        {
            _sidebarSlot.Children.Clear();
            if (Sidebar is not null) _sidebarSlot.Children.Add(Sidebar);

            _centerSlot.Children.Clear();
            if (Center is not null) _centerSlot.Children.Add(Center);

            _detailSlot.Children.Clear();
            if (Detail is not null) _detailSlot.Children.Add(Detail);

            _sidebarHandle.Background = R("MapleBorder");
            _detailHandle.Background = R("MapleBorder");
        }
    }
}
