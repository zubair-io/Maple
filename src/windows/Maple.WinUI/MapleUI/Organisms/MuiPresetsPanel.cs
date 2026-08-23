using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One saved preset.</summary>
    public sealed record MuiPreset(string Id, string Name, DateTimeOffset SavedAt);

    /// <summary>
    /// Maple.UI Presets Panel organism (unified-component-catalog.md
    /// §4.3, "Presets Panel" row: "Save, apply, delete presets", built
    /// from List Row, Button, Dialog) — a <see cref="MuiListRow"/> list of
    /// saved presets (each row's trailing content is Apply/Delete
    /// buttons), a "Save current as preset…" action above, and two
    /// <see cref="MuiDialog"/>s (Prompt for the new preset's name,
    /// Confirm for a destructive delete).
    /// </summary>
    public sealed class MuiPresetsPanel : ContentControl
    {
        public static readonly DependencyProperty PresetsProperty =
            DependencyProperty.Register(nameof(Presets), typeof(IReadOnlyList<MuiPreset>), typeof(MuiPresetsPanel),
                new PropertyMetadata(null, (d, _) => ((MuiPresetsPanel)d).Rebuild()));

        public IReadOnlyList<MuiPreset>? Presets
        {
            get => (IReadOnlyList<MuiPreset>?)GetValue(PresetsProperty);
            set => SetValue(PresetsProperty, value);
        }

        public event EventHandler<string>? PresetSaved;
        public event EventHandler<string>? PresetApplied;
        public event EventHandler<string>? PresetDeleted;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 12 };
        private readonly MuiButton _saveButton = new() { Variant = MuiButtonVariant.Secondary, Label = "Save current as preset…" };
        private readonly StackPanel _rows = new() { Orientation = Orientation.Vertical, Spacing = 2 };
        private readonly MuiEmptyState _empty = new() { IconName = "tool-presets", Title = "No presets yet" };
        private readonly MuiDialog _saveDialog = new() { Variant = MuiDialogVariant.Prompt, Title = "Save preset", PromptPlaceholder = "Preset name", ConfirmLabel = "Save" };
        private readonly MuiDialog _deleteDialog = new() { Variant = MuiDialogVariant.Confirm, Title = "Delete preset?", Message = "This can't be undone.", ConfirmLabel = "Delete", Destructive = true };
        private string? _pendingDeleteId;

        public MuiPresetsPanel()
        {
            _root.Children.Add(_saveButton);
            _root.Children.Add(_rows);
            _root.Children.Add(_empty);
            _root.Children.Add(_saveDialog);
            _root.Children.Add(_deleteDialog);
            Content = _root;

            _saveButton.Click += (_, _) => _saveDialog.IsOpen = true;
            _saveDialog.Confirmed += (_, name) => { _saveDialog.IsOpen = false; if (!string.IsNullOrWhiteSpace(name)) PresetSaved?.Invoke(this, name); };
            _saveDialog.Dismissed += (_, _) => _saveDialog.IsOpen = false;
            _deleteDialog.Confirmed += (_, _) =>
            {
                _deleteDialog.IsOpen = false;
                if (_pendingDeleteId is not null) PresetDeleted?.Invoke(this, _pendingDeleteId);
            };
            _deleteDialog.Dismissed += (_, _) => _deleteDialog.IsOpen = false;

            Rebuild();
        }

        private void Rebuild()
        {
            var presets = Presets ?? Array.Empty<MuiPreset>();
            _empty.Visibility = presets.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            _rows.Visibility = presets.Count > 0 ? Visibility.Visible : Visibility.Collapsed;

            _rows.Children.Clear();
            foreach (var preset in presets)
            {
                var trailing = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 6 };
                var apply = new MuiButton { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm, Label = "Apply" };
                var delete = new MuiButton { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm, Label = "Delete" };
                var presetId = preset.Id;
                apply.Click += (_, _) => PresetApplied?.Invoke(this, presetId);
                delete.Click += (_, _) => { _pendingDeleteId = presetId; _deleteDialog.IsOpen = true; };
                trailing.Children.Add(apply);
                trailing.Children.Add(delete);

                var row = new MuiListRow { Label = preset.Name, IconName = "tool-presets", TrailingContent = trailing };
                _rows.Children.Add(row);
            }
        }
    }
}
