using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Card Detail modal organism (unified-component-catalog.md
    /// §4.4, "Card Detail" row: "Expanded board-card editor", built from
    /// Form Field, Chip Row, Rich Text Editor) — a title
    /// <see cref="MuiFormField"/>, a label <see cref="MuiChipRow"/>
    /// (Editable), and a <see cref="MuiRichTextEditor"/> for the card's
    /// long-form notes.
    /// </summary>
    public sealed class MuiCardDetailModal : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiCardDetailModal),
                new PropertyMetadata(false, (d, e) => ((MuiCardDetailModal)d)._shell.IsOpen = (bool)e.NewValue));

        public static readonly DependencyProperty ContainedProperty =
            DependencyProperty.Register(nameof(Contained), typeof(bool), typeof(MuiCardDetailModal),
                new PropertyMetadata(false, (d, e) => ((MuiCardDetailModal)d)._shell.Contained = (bool)e.NewValue));

        public static readonly DependencyProperty TitleProperty =
            DependencyProperty.Register(nameof(Title), typeof(string), typeof(MuiCardDetailModal),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiCardDetailModal)d)._title.Text = (string)e.NewValue));

        public static readonly DependencyProperty LabelsProperty =
            DependencyProperty.Register(nameof(Labels), typeof(IReadOnlyList<MuiChip>), typeof(MuiCardDetailModal),
                new PropertyMetadata(null, (d, e) => ((MuiCardDetailModal)d)._labels.Chips = (IReadOnlyList<MuiChip>?)e.NewValue));

        public static readonly DependencyProperty NotesProperty =
            DependencyProperty.Register(nameof(Notes), typeof(string), typeof(MuiCardDetailModal),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiCardDetailModal)d)._notes.Value = (string)e.NewValue));

        public bool IsOpen { get => (bool)GetValue(IsOpenProperty); set => SetValue(IsOpenProperty, value); }
        public bool Contained { get => (bool)GetValue(ContainedProperty); set => SetValue(ContainedProperty, value); }
        public string Title { get => (string)GetValue(TitleProperty); set => SetValue(TitleProperty, value); }

        public IReadOnlyList<MuiChip>? Labels
        {
            get => (IReadOnlyList<MuiChip>?)GetValue(LabelsProperty);
            set => SetValue(LabelsProperty, value);
        }

        public string Notes { get => (string)GetValue(NotesProperty); set => SetValue(NotesProperty, value); }

        public event EventHandler? Dismissed;
        public event EventHandler<string>? LabelAdded;
        public event EventHandler<string>? LabelRemoved;

        private readonly MuiOverlayShell _shell = new() { Size = MuiOverlayShellSize.Lg, AriaLabel = "Card Detail" };
        private readonly MuiInput _title = new() { Placeholder = "Card title" };
        private readonly MuiChipRow _labels = new() { Mode = MuiChipRowMode.Editable, AddPlaceholder = "Add label" };
        private readonly MuiRichTextEditor _notes = new();
        private readonly MuiButton _close = new() { Variant = MuiButtonVariant.Primary, Label = "Done" };

        public MuiCardDetailModal()
        {
            var body = new StackPanel { Orientation = Orientation.Vertical, Spacing = 16 };
            body.Children.Add(new MuiFormField { Label = "Title", ControlContent = _title });
            body.Children.Add(new MuiFormField { Label = "Labels", ControlContent = _labels });
            body.Children.Add(new MuiFormField { Label = "Notes", ControlContent = _notes });

            var footer = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
            footer.Children.Add(_close);

            _shell.Header = new MuiText { Text = "Card Detail", Variant = MuiTextVariant.SheetTitle };
            _shell.Body = body;
            _shell.Footer = footer;
            Content = _shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _shell.Dismissed += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _close.Click += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _title.TextChanged += (_, text) => Title = text;
            _labels.Added += (_, label) => LabelAdded?.Invoke(this, label);
            _labels.Removed += (_, id) => LabelRemoved?.Invoke(this, id);
            _notes.ValueChanged += (_, value) => Notes = value;
        }
    }
}
