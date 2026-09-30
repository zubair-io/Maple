using System;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.WinUI.Models;
using Maple.WinUI.Services;

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
    /// the sidecar write. Panel rulers explicitly delimit pointer gestures
    /// so pauses during a drag do not split its undo entry. Overlay changes
    /// still use the quiet-time history boundary.
    /// </summary>
    public sealed partial class MainWindow
    {
        private bool _maskArmed;
        private int _selectedMaskIndex = -1;

        private void BuildMaskPanel()
        {
            MaskPanel.AddLinearRequested += (_, _) => AddMaskLayer(linear: true);
            MaskPanel.GestureStarted += (sender, _) => ViewModel.BeginAdjustmentGesture(sender!);
            MaskPanel.GestureCompleted += (sender, _) => ViewModel.EndAdjustmentGesture(sender!);
            MaskPanel.AddRadialRequested += (_, _) => AddMaskLayer(linear: false);
            MaskPanel.LayerSelected += (_, index) =>
            {
                MaskOverlay.CancelDrag();
                ViewModel.EndAdjustmentGesture();
                _selectedMaskIndex = index;
                _selectedMaskComponentIndex = 0;
                UpdateMaskDisplay();
            };
            MaskPanel.LayerDeleteRequested += (_, index) => DeleteMaskLayer(index);
            MaskPanel.FeatherChanged += (_, value) => EditSelectedMask(l => MaskGroupEditing.WithLeaf(l, _selectedMaskComponentIndex, mask => WithFeather(mask, value / 100.0)));
            MaskPanel.InvertChanged += (_, value) =>
                EditMaskComposition(l => l.Mask is RadialMask r ? l with { Mask = r with { Invert = value } } : l, true);
            MaskPanel.AdjustmentChanged += (_, change) => EditSelectedMask(l => l with { Adjustments = WithControl(l.Adjustments, change.Field, change.Value) });
            MaskPanel.ResetRequested += OnMaskReset;
            MaskOverlay.ShapeChanged += OnMaskOverlayShapeChanged;
            BuildMaskComposition();
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
            MaskOverlay.CancelDrag();
            ViewModel.EndAdjustmentGesture();
            MaskOverlay.Visibility = Visibility.Collapsed;
        }

        /// <summary>Model → mask UI (undo, sidecar reload, photo switch,
        /// live drag). Rebuilds the panel's layer list and pushes the
        /// selected layer's geometry/controls into the overlay + panel.</summary>
        private void SyncMaskFromModel()
        {
            MaskOverlay.CancelDrag();
            ViewModel.EndAdjustmentGesture();
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
            SyncMaskComposition(selected);
            var leaf = MaskGroupEditing.SelectedLeaf(selected, _selectedMaskComponentIndex);
            MaskOverlay.Shape = leaf switch
            {
                LinearMask l => new MuiLinearMaskShape(new MuiMaskPoint(l.Start.X, l.Start.Y), new MuiMaskPoint(l.End.X, l.End.Y)),
                RadialMask r => new MuiRadialMaskShape(new MuiMaskPoint(r.Center.X, r.Center.Y), new MuiMaskPoint(r.Radii.X, r.Radii.Y), r.Angle),
                _ => null,
            };
            MaskOverlay.Invert = leaf is RadialMask { Invert: true };
            MaskOverlay.Visibility = selected is null ? Visibility.Collapsed : Visibility.Visible;

            var feather = leaf switch { LinearMask l => l.Feather, RadialMask r => r.Feather, _ => 0.5 };
            MaskPanel.Feather = feather * 100;
            MaskPanel.Invert = selected?.Mask is RadialMask { Invert: true };
            MaskPanel.Adjustments = ToMuiAdjustments(selected?.Adjustments ?? new PartialAdjustments());
        }

        // --- Layer list rows ---

        private MuiMaskLayerRow ToRow(LocalAdjustment layer, int index, System.Collections.Generic.List<LocalAdjustment> all)
        {
            var isRadial = layer.Mask is RadialMask;
            var ordinal = all.Take(index + 1).Count(l => l.Mask.GetType() == layer.Mask.GetType());
            var kind = layer.Mask is MaskGroup ? "Mask group" : isRadial ? "Radial" : "Linear";
            var name = $"{kind} {ordinal}";
            var editedCount = CountEdited(layer.Adjustments);
            var invertedNote = layer.Mask is RadialMask { Invert: true } ? "inverted" : null;
            var editedNote = editedCount > 0 ? $"{editedCount} edited" : null;
            var componentNote = layer.Mask is MaskGroup group ? $"{group.Components.Count} components" : null;
            var subtitle = string.Join(" · ", new[] { componentNote, invertedNote, editedNote }.Where(s => s != null));
            return new MuiMaskLayerRow(index.ToString(), name, subtitle, index == _selectedMaskIndex, isRadial);
        }

        private static int CountEdited(PartialAdjustments a) =>
            new[] { a.Exposure, a.Contrast, a.Highlights, a.Shadows, a.Whites, a.Blacks, a.Saturation, a.Vibrance, a.Temperature, a.Tint, a.Hue,
                a.Texture, a.Clarity, a.Dehaze, a.Sharpness, a.LuminanceNoise, a.Defringe }
                .Count(v => v is not null);

        // --- Add / delete / reset ---

        private void AddMaskLayer(bool linear)
        {
            var layer = linear
                ? new LocalAdjustment(new LinearMask(new MaskPoint(0.3, 0.5), new MaskPoint(0.7, 0.5), 0.5), new PartialAdjustments())
                : new LocalAdjustment(DefaultRadialMask(), new PartialAdjustments());
            ViewModel.CommitPendingAdjustmentGesture();
            ViewModel.Adjustments.LocalAdjustments.Add(layer);
            _selectedMaskIndex = ViewModel.Adjustments.LocalAdjustments.Count - 1;
            _selectedMaskComponentIndex = 0;
            ViewModel.NotifyAdjustmentEdited();
            ViewModel.CommitPendingAdjustmentGesture();
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
            ViewModel.CommitPendingAdjustmentGesture();
            if (index == _selectedMaskIndex) _selectedMaskComponentIndex = 0;
            layers.RemoveAt(index);
            _selectedMaskIndex = MaskLayerSelectionLogic.AfterDelete(_selectedMaskIndex, index, layers.Count);
            ViewModel.NotifyAdjustmentEdited();
            ViewModel.CommitPendingAdjustmentGesture();
            SyncMaskFromModel();
        }

        private void OnMaskReset(object? sender, EventArgs e)
        {
            EditMaskComposition(l => l with { Adjustments = new PartialAdjustments() }, true);
            UpdateMaskDisplay();
        }

        // --- Overlay drag → model ---

        private void OnMaskOverlayShapeChanged(object? sender, MuiMaskShape shape) =>
            EditSelectedMask(l => MaskGroupEditing.WithLeaf(l, _selectedMaskComponentIndex, mask => (shape, mask) switch
            {
                (MuiLinearMaskShape lin, LinearMask existing) => existing with
                {
                    Start = new MaskPoint(lin.Start.X, lin.Start.Y),
                    End = new MaskPoint(lin.End.X, lin.End.Y),
                },
                (MuiRadialMaskShape rad, RadialMask existing) => existing with
                {
                    Center = new MaskPoint(rad.Center.X, rad.Center.Y),
                    Radii = new MaskPoint(rad.Radii.X, rad.Radii.Y),
                    Angle = rad.Angle,
                },
                _ => mask, // shape/model kind mismatch (selection changed mid-drag) — no-op
            }));

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
            var before = layers[_selectedMaskIndex];
            var after = edit(before);
            if (after == before) return;
            layers[_selectedMaskIndex] = after;
            ViewModel.NotifyAdjustmentEdited();
            MaskPanel.Layers = layers.Select((layer, i) => ToRow(layer, i, layers)).ToList();
            SyncMaskComposition(after);
        }

        private static LocalMask WithFeather(LocalMask mask, double feather01) => mask switch
        {
            LinearMask lin => lin with { Feather = feather01 },
            RadialMask rad => rad with { Feather = feather01 },
            _ => mask,
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
