using System;
using System.Linq;
using Maple.UI;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;
using Maple.WinUI.Services;

namespace Maple.WinUI
{
    public sealed partial class MainWindow
    {
        private int _selectedMaskComponentIndex;

        private void BuildMaskComposition()
        {
            var composition = MaskPanel.Composition;
            composition.GestureStarted += (_, _) => ViewModel.BeginAdjustmentGesture();
            composition.GestureEnded += (_, _) => ViewModel.EndAdjustmentGesture();
            MaskPanel.GestureStarted += (_, _) => ViewModel.BeginAdjustmentGesture();
            MaskPanel.GestureEnded += (_, _) => ViewModel.EndAdjustmentGesture();
            MaskOverlay.GestureStarted += (_, _) => ViewModel.BeginAdjustmentGesture();
            MaskOverlay.GestureEnded += (_, _) => ViewModel.EndAdjustmentGesture();
            composition.AddRequested += (_, request) =>
            {
                if (!Enum.TryParse<MaskCombine>(request.Combine, out var combine)) return;
                var leaf = request.Linear ? (LocalMask)new LinearMask(new(0.3, 0.5), new(0.7, 0.5), 0.5) : DefaultRadialMask();
                EditMaskComposition(layer => MaskGroupEditing.Add(layer, leaf, combine), true);
                if (SelectedMaskLayer()?.Mask is MaskGroup group) _selectedMaskComponentIndex = group.Components.Count - 1;
                UpdateMaskDisplay();
            };
            composition.Selected += (_, index) =>
            {
                if (SelectedMaskLayer()?.Mask is not MaskGroup group || index < 0 || index >= group.Components.Count) return;
                MaskOverlay.CancelDrag();
                ViewModel.EndAdjustmentGesture();
                ViewModel.CommitPendingAdjustmentGesture();
                _selectedMaskComponentIndex = index;
                UpdateMaskDisplay();
            };
            composition.DeleteRequested += (_, index) =>
            {
                if (SelectedMaskLayer()?.Mask is not MaskGroup group || group.Components.Count <= 1
                    || index < 0 || index >= group.Components.Count) return;
                var selectedBeforeDelete = _selectedMaskComponentIndex;
                EditMaskComposition(layer => MaskGroupEditing.Remove(layer, index), true);
                _selectedMaskComponentIndex = MaskLayerSelectionLogic.AfterDelete(selectedBeforeDelete, index, group.Components.Count - 1);
                UpdateMaskDisplay();
            };
            composition.CombineChanged += (_, value) =>
            {
                if (Enum.TryParse<MaskCombine>(value, out var combine))
                    EditMaskComposition(layer => MaskGroupEditing.WithCombine(layer, _selectedMaskComponentIndex, combine), true);
            };
            composition.ComponentInverted += (_, value) =>
                EditMaskComposition(layer => MaskGroupEditing.WithComponentInverted(layer, _selectedMaskComponentIndex, value), true);
            composition.GroupInverted += (_, value) =>
                EditMaskComposition(layer => MaskGroupEditing.WithGroupInverted(layer, value), true);
            composition.OpacityChanged += (_, value) =>
                EditMaskComposition(layer => MaskGroupEditing.WithOpacity(layer, value), false);
        }

        private LocalAdjustment? SelectedMaskLayer()
        {
            var layers = ViewModel.Adjustments.LocalAdjustments;
            return _selectedMaskIndex >= 0 && _selectedMaskIndex < layers.Count ? layers[_selectedMaskIndex] : null;
        }

        private void SyncMaskComposition(LocalAdjustment? layer)
        {
            if (layer?.Mask is not MaskGroup group)
            {
                _selectedMaskComponentIndex = 0;
                MaskPanel.Composition.Sync(Array.Empty<MuiMaskComponentRow>(), 1, false);
                return;
            }
            _selectedMaskComponentIndex = Math.Clamp(_selectedMaskComponentIndex, 0, Math.Max(0, group.Components.Count - 1));
            var rows = group.Components.Select((component, index) => new MuiMaskComponentRow(
                $"{(component.Mask is RadialMask ? "Radial" : "Linear")} {index + 1}", component.Combine.ToString(),
                component.Invert, index == _selectedMaskComponentIndex)).ToArray();
            MaskPanel.Composition.Sync(rows, group.Opacity, group.Invert);
        }

        private void EditMaskComposition(Func<LocalAdjustment, LocalAdjustment> edit, bool discrete)
        {
            if (discrete)
            {
                MaskOverlay.CancelDrag();
                ViewModel.EndAdjustmentGesture();
                ViewModel.CommitPendingAdjustmentGesture();
            }
            EditSelectedMask(edit);
            if (discrete) ViewModel.CommitPendingAdjustmentGesture();
        }
    }
}
