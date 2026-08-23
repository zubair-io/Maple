using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One toggleable adjustment group in a Selective Paste run.</summary>
    public sealed record MuiSelectivePasteGroup(string Id, string Label);

    /// <summary>
    /// Maple.UI Selective Paste modal organism (unified-component-catalog.md
    /// §4.4, "Selective Paste" row: "Per-group apply toggles", built from
    /// Checkbox, Text, Button) — one <see cref="MuiCheckbox"/> per tool
    /// group (Light, Color, Effects, …), each labeled with a
    /// <see cref="MuiText"/>, gating which groups a Paste actually
    /// applies.
    /// </summary>
    public sealed class MuiSelectivePasteModal : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiSelectivePasteModal),
                new PropertyMetadata(false, (d, e) => ((MuiSelectivePasteModal)d)._shell.IsOpen = (bool)e.NewValue));

        public static readonly DependencyProperty ContainedProperty =
            DependencyProperty.Register(nameof(Contained), typeof(bool), typeof(MuiSelectivePasteModal),
                new PropertyMetadata(false, (d, e) => ((MuiSelectivePasteModal)d)._shell.Contained = (bool)e.NewValue));

        public static readonly DependencyProperty GroupsProperty =
            DependencyProperty.Register(nameof(Groups), typeof(IReadOnlyList<MuiSelectivePasteGroup>), typeof(MuiSelectivePasteModal),
                new PropertyMetadata(null, (d, _) => ((MuiSelectivePasteModal)d).Rebuild()));

        public static readonly DependencyProperty SelectedGroupIdsProperty =
            DependencyProperty.Register(nameof(SelectedGroupIds), typeof(IReadOnlyList<string>), typeof(MuiSelectivePasteModal),
                new PropertyMetadata(null, (d, _) => ((MuiSelectivePasteModal)d).Rebuild()));

        public bool IsOpen { get => (bool)GetValue(IsOpenProperty); set => SetValue(IsOpenProperty, value); }
        public bool Contained { get => (bool)GetValue(ContainedProperty); set => SetValue(ContainedProperty, value); }

        public IReadOnlyList<MuiSelectivePasteGroup>? Groups
        {
            get => (IReadOnlyList<MuiSelectivePasteGroup>?)GetValue(GroupsProperty);
            set => SetValue(GroupsProperty, value);
        }

        public IReadOnlyList<string>? SelectedGroupIds
        {
            get => (IReadOnlyList<string>?)GetValue(SelectedGroupIdsProperty);
            set => SetValue(SelectedGroupIdsProperty, value);
        }

        public event EventHandler? Dismissed;
        public event EventHandler<IReadOnlyList<string>>? PasteRequested;

        private readonly MuiOverlayShell _shell = new() { Size = MuiOverlayShellSize.Sm, AriaLabel = "Selective Paste" };
        private readonly StackPanel _checks = new() { Orientation = Orientation.Vertical, Spacing = 8 };
        private readonly MuiButton _cancel = new() { Variant = MuiButtonVariant.Ghost, Label = "Cancel" };
        private readonly MuiButton _paste = new() { Variant = MuiButtonVariant.Primary, Label = "Paste" };

        public MuiSelectivePasteModal()
        {
            var footer = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
            footer.Children.Add(_cancel);
            footer.Children.Add(_paste);

            _shell.Header = new MuiText { Text = "Selective Paste", Variant = MuiTextVariant.SheetTitle };
            _shell.Body = _checks;
            _shell.Footer = footer;
            Content = _shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _shell.Dismissed += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _cancel.Click += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _paste.Click += (_, _) => PasteRequested?.Invoke(this, SelectedGroupIds ?? Array.Empty<string>());

            Rebuild();
        }

        private void Rebuild()
        {
            var selected = SelectedGroupIds is null ? new HashSet<string>() : new HashSet<string>(SelectedGroupIds);
            _checks.Children.Clear();
            foreach (var group in Groups ?? Array.Empty<MuiSelectivePasteGroup>())
            {
                var checkbox = new MuiCheckbox { Label = group.Label, CheckedState = selected.Contains(group.Id) };
                var groupId = group.Id;
                checkbox.Checked += (_, _) => Toggle(groupId, true);
                checkbox.Unchecked += (_, _) => Toggle(groupId, false);
                _checks.Children.Add(checkbox);
            }
        }

        private void Toggle(string groupId, bool selected)
        {
            var current = SelectedGroupIds is null ? new HashSet<string>() : new HashSet<string>(SelectedGroupIds);
            if (selected) current.Add(groupId); else current.Remove(groupId);
            SelectedGroupIds = current.ToList();
        }
    }
}
