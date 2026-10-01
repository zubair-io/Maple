using System;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading.Tasks;
using System.Threading;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media.Imaging;
using Maple.WinUI.Native;
using Maple.WinUI.Services;
using Maple.WinUI.Models;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private readonly ComparisonGesture _compare = new();
    private readonly CancelFlagSlot _compareCancel = new(RawFfi.maple_cancel_flag_set, RawFfi.maple_cancel_flag_free);
    private int _compareGeneration;
    private bool _compareLoading;
    private bool _comparePointer;
    private bool _ignoreCompareClick;
    private int _openingSnapshotVersion;
    private CancellationTokenSource? _compareWork;

    private void OnEditorModelSynced()
    {
        // A cloud sidecar can arrive after its embedded preview. Never keep a
        // comparison rendered from the temporary default opening model.
        if (_openingSnapshotVersion != ViewModel.OpeningSnapshotVersion)
        {
            _openingSnapshotVersion = ViewModel.OpeningSnapshotVersion;
            ResetComparison();
        }
        UpdateEditStatus();
    }

    private void InitializeComparison()
    {
        CompareButton.AddHandler(UIElement.PointerPressedEvent, new PointerEventHandler(OnComparePressed), true);
        CompareButton.AddHandler(UIElement.PointerReleasedEvent, new PointerEventHandler(OnCompareReleased), true);
        CompareButton.PointerCaptureLost += (_, _) =>
        {
            DispatcherQueue.TryEnqueue(() =>
            {
                if (_comparePointer) { _comparePointer = false; _compare.Cancel(); UpdateComparison(); }
                _ignoreCompareClick = false;
            });
        };
        CompareButton.LostFocus += (_, _) => { _compare.Cancel(); UpdateComparison(); };
        Activated += (_, e) =>
        {
            if (e.WindowActivationState == WindowActivationState.Deactivated) { _compare.Cancel(); UpdateComparison(); }
        };
        ((FrameworkElement)Content).KeyUp += OnComparisonKeyUp;
        ((FrameworkElement)Content).LostFocus += (_, _) =>
        {
            if (_compare.IsPressed && !_comparePointer) { _compare.Cancel(); UpdateComparison(); }
        };
    }

    private void OnComparePressed(object sender, PointerRoutedEventArgs e)
    {
        if (!e.GetCurrentPoint(CompareButton).Properties.IsLeftButtonPressed) return;
        _comparePointer = true;
        _ignoreCompareClick = true;
        _compare.Press(Environment.TickCount64);
        UpdateComparison();
    }
    private void OnCompareReleased(object sender, PointerRoutedEventArgs e)
    {
        if (!_comparePointer) return;
        _comparePointer = false;
        _compare.Release(Environment.TickCount64);
        UpdateComparison();
        DispatcherQueue.TryEnqueue(() => _ignoreCompareClick = false);
    }

    private void UpdateEditStatus()
    {
        var status = ViewModel.AdjustmentsReady && ViewModel.HasNonDefaultEdits() ? " · Edited" : string.Empty;
        EditStatusText.Text = $"{ViewModel.SelectedPhoto?.Format}" + status;
        BrowseEditedStatus.Text = status;
    }
    private void OnCompareClick(object sender, RoutedEventArgs e)
    {
        if (_ignoreCompareClick) { _ignoreCompareClick = false; return; }
        _compare.Toggle();
        UpdateComparison();
    }
    private void OnComparisonKeyUp(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key is Windows.System.VirtualKey.B or (Windows.System.VirtualKey)0xDC && _compare.IsPressed)
        {
            _compare.Release(Environment.TickCount64);
            UpdateComparison();
            e.Handled = true;
        }
    }

    private void ResetComparison()
    {
        _compareGeneration++;
        _compareCancel.Cancel();
        _compareWork?.Cancel();
        _compare.Reset();
        _comparePointer = _ignoreCompareClick = false;
        _compareLoading = false;
        ComparisonImage.Source = null;
        ComparisonImage.Visibility = Visibility.Collapsed;
        ComparisonStatus.Visibility = Visibility.Collapsed;
        CompareButton.Label = string.Empty;
        CompareButton.IconColor = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources["MapleTextMain"];
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(CompareButton, "Compare before and after");
    }

    private void UpdateComparison()
    {
        if (_closing) return;
        var showing = _mode == ShellMode.Edit && _compare.ShowingBefore;
        ComparisonImage.Visibility = showing && ComparisonImage.Source != null ? Visibility.Visible : Visibility.Collapsed;
        CompareButton.Label = string.Empty;
        CompareButton.IconColor = (Microsoft.UI.Xaml.Media.Brush)Application.Current.Resources[showing ? "MaplePrimary" : "MapleTextMain"];
        Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(CompareButton,
            showing ? "Showing before; show edited photo" : "Compare before and after");
        ComparisonStatus.Visibility = showing ? Visibility.Visible : Visibility.Collapsed;
        if (!showing) return;
        if (ComparisonImage.Source == null && !_compareLoading) _ = PrepareComparisonAsync();
        else if (ComparisonImage.Source != null) ComparisonStatus.Text = "Before · state at open";
    }

    private async Task PrepareComparisonAsync()
    {
        var photo = ViewModel.SelectedPhoto;
        if (photo == null) return;
        if (photo.IsCloud && photo.LocalCachePath == null)
        {
            ComparisonStatus.Text = "Comparison will be available after the original downloads.";
            return;
        }
        var generation = _compareGeneration;
        var baseline = ViewModel.OpeningSnapshot();
        var path = photo.EditPath;
        var flag = RawFfi.maple_cancel_flag_new();
        _compareCancel.Reset(flag);
        _compareLoading = true;
        using var work = new CancellationTokenSource();
        _compareWork = work;
        ComparisonStatus.Text = "Preparing comparison…";
        try
        {
            var frame = await Task.Run(async () =>
            {
                try
                {
                    var film = await ViewModel.Renderer.LoadDetailFilmAsync(baseline.FilmLook, work.Token);
                    work.Token.ThrowIfCancellationRequested();
                    var decoded = RenderEngine.Decode(path, baseline, 1600, RefineDecodeQuality.Preview, flag);
                    // Same as-shot identity normalization as the live opening render.
                    if (baseline.Temperature == 6500 && baseline.Tint == 0 && decoded.DecodedTemperature > 0)
                    { baseline.Temperature = decoded.DecodedTemperature; baseline.Tint = decoded.DecodedTint; }
                    float[]? scratch = null;
                    var pixelCount = checked((long)decoded.Width * decoded.Height);
                    if (decoded.Width <= 0 || decoded.Height <= 0 || pixelCount > 268_000_000)
                        throw new System.IO.InvalidDataException("Comparison dimensions exceed the image limit.");
                    var pixels = new byte[checked((int)(pixelCount * 4))];
                    RenderEngine.RenderTick(decoded, baseline, ref scratch, pixels, film);
                    return (decoded.Width, decoded.Height, pixels);
                }
                finally { _compareCancel.Release(flag); }
            });
            if (_closing || generation != _compareGeneration || !ReferenceEquals(photo, ViewModel.SelectedPhoto)) return;
            var bitmap = new WriteableBitmap(frame.Width, frame.Height);
            using (var stream = bitmap.PixelBuffer.AsStream()) stream.Write(frame.pixels);
            bitmap.Invalidate();
            ComparisonImage.Source = bitmap;
            UpdateComparison();
        }
        catch (Exception error)
        {
            if (!_closing && generation == _compareGeneration)
            {
                ComparisonStatus.Text = "Comparison unavailable. Try again after the photo finishes loading.";
                DiagLog.Write($"[compare] {error.Message}");
            }
        }
        finally
        {
            if (ReferenceEquals(_compareWork, work)) _compareWork = null;
            if (generation == _compareGeneration) _compareLoading = false;
        }
    }
}
