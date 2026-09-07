using System;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.WinUI.Models;

namespace Maple.WinUI
{
    /// <summary>
    /// Mask mode (#3406, parity with web #3301 / Apple #3285): linear and
    /// radial local-adjustment layers. Follows the same shell shape as
    /// Crop (MainWindow.Crop.cs) — the tool swaps in a canvas overlay
    /// (<see cref="MaskOverlay"/>, positioned onto the image footprint from
    /// code) plus a panel (<see cref="MaskPanel"/>) — but unlike Crop it
    /// never changes the crop/rotate display state: masks are edited over
    /// whatever the photo's committed crop and straighten angle already
    /// show, and <see cref="MaskOverlay"/> lives INSIDE CropRotateHost in
    /// XAML precisely so it inherits that same rotation + translate/scale
    /// transform chain (mask-overlay.md's "cropped image" state) with no
    /// hand-rolled affine math needed here.
    ///
    /// Selection is transient UI state (never persisted, never an undo
    /// entry) — the same convention Crop's own transient aspect-id follows.
    /// Every model write funnels through <see cref="EditSessionViewModel.
    /// NotifyAdjustmentEdited"/>, which re-renders immediately and debounces
    /// the sidecar write + undo-boundary commit — so a handle drag or a
    /// slider drag each coalesce into exactly one undo entry, closed when
    /// the pointer stops moving for 450ms, matching every other gesture on
    /// Windows (mask-panel.md / mask-overlay.md's "one undo entry per drag").
    /// </summary>
    public sealed partial class MainWindow
    {
        private bool _maskArmed;
        private int _selectedMaskIndex = -1;

        private void BuildMaskPanel()
        {
            MaskPanel.AddLinearRequested += (_, _) => AddMaskLayer(linear: true);
            MaskPanel.AddRadialRequested += (_, _) => AddMaskLayer(linear: false);
            MaskPanel.LayerSelected += (_, index) => { _selectedMaskIndex = index; UpdateMaskDisplay(); };
            MaskPanel.LayerDeleteRequested += (_, index) => DeleteMaskLayer(index);
            MaskPanel.FeatherChanged += (_, value) => EditSelectedMask(l => WithFeather(l, value / 100.0));
            MaskPanel.InvertChanged += (_, value) =>
                EditSelectedMask(l => l.Mask is RadialMask r ? l with { Mask = r with { Invert = value } } : l);
            MaskPanel.AdjustmentChanged += (_, change) => EditSelectedMask(l => l with { Adjustments = WithControl(l.Adjustments, change.Field, change.Value) });
            MaskPanel.ResetRequested += OnMaskReset;
            MaskOverlay.ShapeChanged += OnMaskOverlayShapeChanged;
        }

        private void EnterMaskMode()
        {
            _maskArmed = true;
            var layers = ViewModel.Adjustments.LocalAdjustments;
            if (_selectedMaskIndex < 0 || _selectedMaskIndex >= layers.Count)
                _selectedMaskIndex = layers.Count > 0 ? 0 : -1;
            ResetZoom();                              // overlay math assumes fit, same as Crop
            UpdateMaskDisplay();
        }

        private void ExitMaskMode()
        {
            if (!_maskArmed)
                return;
            _maskArmed = false;
            MaskOverlay.Visibility = Visibility.Collapsed;
        }

        /// <summary>Model → mask UI (undo, sidecar reload, photo switch,
        /// live drag). Rebuilds the panel's layer list and pushes the
        /// selected layer's geometry/controls into the overlay + panel.</summary>
        private void SyncMaskFromModel()
        {
            var layers = ViewModel.Adjustments.LocalAdjustments;
            if (_selectedMaskIndex >= layers.Count)
                _selectedMaskIndex = layers.Count > 0 ? layers.Count - 1 : -1;
            MaskPanel.Layers = layers.Select((layer, i) => ToRow(layer, i, layers)).ToList();
            if (_maskArmed)
                UpdateMaskDisplay();
        }

        private void UpdateMaskDisplay()
        {
            if (!_maskArmed || ContentFitRect() is not { } f || _mode != ShellMode.Edit)
            {
                MaskOverlay.Visibility = Visibility.Collapsed;
                return;
            }
            MaskOverlay.Margin = new Thickness(f.X, f.Y, 0, 0);
            MaskOverlay.Bounds = new Windows.Foundation.Size(f.W, f.H);

            var layers = ViewModel.Adjustments.LocalAdjustments;
            var selected = _selectedMaskIndex >= 0 && _selectedMaskIndex < layers.Count ? layers[_selectedMaskIndex] : null;
            MaskOverlay.Shape = selected?.Mask switch
            {
                LinearMask l => new MuiLinearMaskShape(new MuiMaskPoint(l.Start.X, l.Start.Y), new MuiMaskPoint(l.End.X, l.End.Y)),
                RadialMask r => new MuiRadialMaskShape(new MuiMaskPoint(r.Center.X, r.Center.Y), new MuiMaskPoint(r.Radii.X, r.Radii.Y), r.Angle),
                _ => null,
            };
            MaskOverlay.Invert = selected?.Mask is RadialMask { Invert: true };
            MaskOverlay.Visibility = selected is null ? Visibility.Collapsed : Visibility.Visible;

            var feather = selected?.Mask switch { LinearMask l => l.Feather, RadialMask r => r.Feather, _ => 0.5 };
            MaskPanel.Feather = feather * 100;
            MaskPanel.Invert = selected?.Mask is RadialMask { Invert: true };
            MaskPanel.Adjustments = ToMuiAdjustments(selected?.Adjustments ?? new PartialAdjustments());
        }

        // --- Layer list rows ---

        private MuiMaskLayerRow ToRow(LocalAdjustment layer, int index, System.Collections.Generic.List<LocalAdjustment> all)
        {
            var isRadial = layer.Mask is RadialMask;
            var ordinal = all.Take(index + 1).Count(l => (l.Mask is RadialMask) == isRadial);
            var name = $"{(isRadial ? "Radial" : "Linear")} {ordinal}";
            var editedCount = CountEdited(layer.Adjustments);
            var invertedNote = layer.Mask is RadialMask { Invert: true } ? "inverted" : null;
            var editedNote = editedCount > 0 ? $"{editedCount} edited" : null;
            var subtitle = string.Join(" · ", new[] { invertedNote, editedNote }.Where(s => s != null));
            return new MuiMaskLayerRow(index.ToString(), name, subtitle, index == _selectedMaskIndex, isRadial);
        }

        private static int CountEdited(PartialAdjustments a) =>
            new[] { a.Exposure, a.Contrast, a.Highlights, a.Shadows, a.Whites, a.Blacks, a.Saturation, a.Vibrance, a.Temperature, a.Tint, a.Hue }
                .Count(v => v is not null);

        // --- Add / delete / reset ---

        private void AddMaskLayer(bool linear)
        {
            var layer = linear
                ? new LocalAdjustment(new LinearMask(new MaskPoint(0.3, 0.5), new MaskPoint(0.7, 0.5), 0.5), new PartialAdjustments())
                : new LocalAdjustment(DefaultRadialMask(), new PartialAdjustments());
            ViewModel.Adjustments.LocalAdjustments.Add(layer);
            _selectedMaskIndex = ViewModel.Adjustments.LocalAdjustments.Count - 1;
            ViewModel.NotifyAdjustmentEdited();
            SyncMaskFromModel();
        }

        /// <summary>A fresh radial mask's Y-radius is pre-corrected by the
        /// footprint's aspect so it reads as a circle on screen — the same
        /// contract mask-panel.md documents for web/Apple. Falls back to a
        /// square radius when no footprint is available yet (photo not
        /// decoded/laid out).</summary>
        private RadialMask DefaultRadialMask()
        {
            const double rx = 0.2;
            var aspect = ContentFitRect() is { } f && f.H > 0 ? f.W / f.H : 1.0;
            return new RadialMask(new MaskPoint(0.5, 0.5), new MaskPoint(rx, rx * aspect), 0, 0.5, false);
        }

        private void DeleteMaskLayer(int index)
        {
            var layers = ViewModel.Adjustments.LocalAdjustments;
            if (index < 0 || index >= layers.Count)
                return;
            layers.RemoveAt(index);
            _selectedMaskIndex = layers.Count == 0 ? -1 : Math.Min(index, layers.Count - 1);
            ViewModel.NotifyAdjustmentEdited();
            SyncMaskFromModel();
        }

        private void OnMaskReset(object? sender, RoutedEventArgs e) =>
            EditSelectedMask(l => l with { Adjustments = new PartialAdjustments() });

        // --- Overlay drag → model ---

        private void OnMaskOverlayShapeChanged(object? sender, MuiMaskShape shape) =>
            EditSelectedMask(l => (shape, l.Mask) switch
            {
                (MuiLinearMaskShape lin, LinearMask existing) => l with
                {
                    Mask = existing with
                    {
                        Start = new MaskPoint(lin.Start.X, lin.Start.Y),
                        End = new MaskPoint(lin.End.X, lin.End.Y),
                    },
                },
                (MuiRadialMaskShape rad, RadialMask existing) => l with
                {
                    Mask = existing with
                    {
                        Center = new MaskPoint(rad.Center.X, rad.Center.Y),
                        Radii = new MaskPoint(rad.Radii.X, rad.Radii.Y),
                        Angle = rad.Angle,
                    },
                },
                _ => l, // shape/model kind mismatch (selection changed mid-drag) — no-op
            });

        // --- Shared apply helper ---

        /// <summary>Applies <paramref name="edit"/> to the selected layer,
        /// re-renders, and refreshes the panel's layer-row text (edited
        /// count / inverted note can change every keystroke). Overlay
        /// geometry is NOT re-pushed here — the overlay already holds the
        /// value the drag just produced, and re-pushing it would fight an
        /// in-progress pointer capture.</summary>
        private void EditSelectedMask(Func<LocalAdjustment, LocalAdjustment> edit)
        {
            var layers = ViewModel.Adjustments.LocalAdjustments;
            if (_selectedMaskIndex < 0 || _selectedMaskIndex >= layers.Count)
                return;
            layers[_selectedMaskIndex] = edit(layers[_selectedMaskIndex]);
            ViewModel.NotifyAdjustmentEdited();
            MaskPanel.Layers = layers.Select((layer, i) => ToRow(layer, i, layers)).ToList();
        }

        private static LocalAdjustment WithFeather(LocalAdjustment l, double feather01) => l.Mask switch
        {
            LinearMask lin => l with { Mask = lin with { Feather = feather01 } },
            RadialMask rad => l with { Mask = rad with { Feather = feather01 } },
            _ => l,
        };

        private static PartialAdjustments WithControl(PartialAdjustments a, string field, double value) => field switch
        {
            "Exposure" => a with { Exposure = value },
            "Contrast" => a with { Contrast = value },
            "Highlights" => a with { Highlights = value },
            "Shadows" => a with { Shadows = value },
            "Whites" => a with { Whites = value },
            "Blacks" => a with { Blacks = value },
            "Saturation" => a with { Saturation = value },
            "Vibrance" => a with { Vibrance = value },
            "Temperature" => a with { Temperature = value },
            "Tint" => a with { Tint = value },
            "Hue" => a with { Hue = value },
            _ => a,
        };

        private static MuiPartialAdjustments ToMuiAdjustments(PartialAdjustments a) => new(
            Exposure: a.Exposure, Contrast: a.Contrast, Highlights: a.Highlights, Shadows: a.Shadows,
            Whites: a.Whites, Blacks: a.Blacks, Saturation: a.Saturation, Vibrance: a.Vibrance,
            Temperature: a.Temperature, Tint: a.Tint, Hue: a.Hue);
    }
}
