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
        public event EventHandler? SelectionChanged;
        public event EventHandler? CancelRequested;
        public event EventHandler<IReadOnlyList<string>>? PasteRequested;

        public bool CanApply { get => _paste.IsEnabled; set => _paste.IsEnabled = value; }
        public bool IsApplying { get; set; }
        public string ApplyLabel { set => _paste.Label = value; }
        public string CancelLabel { set => _cancel.Label = value; }
        public string Title { set => _heading.Text = value; }
        public UIElement? PreviewContent { set => _preview.Content = value; }
        public double BodyMaxHeight { set => _scroll.MaxHeight = value; }
        public bool GroupsEnabled
        {
            set
            {
                _groupsEnabled = value;
                foreach (var checkbox in _checks.Children.OfType<MuiCheckbox>()) checkbox.IsEnabled = value;
            }
        }
        private bool _groupsEnabled = true;

        private readonly MuiOverlayShell _shell = new() { Size = MuiOverlayShellSize.Sm, AriaLabel = "Selective Paste" };
        private readonly StackPanel _checks = new() { Orientation = Orientation.Vertical, Spacing = 8 };
        private readonly MuiButton _cancel = new() { Variant = MuiButtonVariant.Ghost, Label = "Cancel" };
        private readonly MuiButton _paste = new() { Variant = MuiButtonVariant.Primary, Label = "Paste" };
        private readonly MuiText _heading = new() { Text = "Selective Paste", Variant = MuiTextVariant.SheetTitle };
        private readonly ContentControl _preview = new() { HorizontalContentAlignment = HorizontalAlignment.Stretch };
        private readonly ScrollViewer _scroll = new() { MaxHeight = 480, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        private bool _updatingSelection;

        public MuiSelectivePasteModal() : this(false) { }

        public MuiSelectivePasteModal(bool embedded)
        {
            var footer = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
            footer.Children.Add(_cancel);
            footer.Children.Add(_paste);

            var body = new StackPanel { Spacing = 16 };
            body.Children.Add(_checks);
            body.Children.Add(_preview);
            _scroll.Content = body;
            _shell.Header = _heading;
            _shell.Body = _scroll;
            _shell.Footer = footer;
            if (embedded)
            {
                // ContentDialog supplies the surface and focus trap.
                _shell.Header = null;
                _shell.Body = null;
                _shell.Footer = null;
                var panel = new Grid { RowSpacing = 16 };
                panel.RowDefinitions.Add(new() { Height = GridLength.Auto });
                panel.RowDefinitions.Add(new() { Height = new GridLength(1, GridUnitType.Star) });
                panel.RowDefinitions.Add(new() { Height = GridLength.Auto });
                Grid.SetRow(_scroll, 1);
                Grid.SetRow(footer, 2);
                panel.Children.Add(_heading);
                panel.Children.Add(_scroll);
                panel.Children.Add(footer);
                Content = panel;
            }
            else Content = _shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _shell.Dismissed += (_, _) => RequestDismiss();
            _cancel.Click += (_, _) => RequestDismiss();
            _paste.Click += (_, _) => PasteRequested?.Invoke(this, SelectedGroupIds ?? Array.Empty<string>());

            Rebuild();
        }

        private void Rebuild()
        {
            if (_updatingSelection) return;
            var selected = SelectedGroupIds is null ? new HashSet<string>() : new HashSet<string>(SelectedGroupIds);
            _checks.Children.Clear();
            foreach (var group in Groups ?? Array.Empty<MuiSelectivePasteGroup>())
            {
                var checkbox = new MuiCheckbox { Label = group.Label, IsThreeState = false, CheckedState = selected.Contains(group.Id), IsEnabled = _groupsEnabled };
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
            // Keep the focused checkbox alive while keyboard users select groups.
            _updatingSelection = true;
            try { SelectedGroupIds = current.ToList(); }
            finally { _updatingSelection = false; }
            SelectionChanged?.Invoke(this, EventArgs.Empty);
        }

        private void RequestDismiss()
        {
            if (IsApplying) { CancelRequested?.Invoke(this, EventArgs.Empty); return; }
            IsOpen = false;
            Dismissed?.Invoke(this, EventArgs.Empty);
        }
    }
}
