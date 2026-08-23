using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Batch Rename modal organism (unified-component-catalog.md
    /// §4.4, "Batch Rename" row: "Template with live preview", built from
    /// Form Field, Chip Row, Preview List, Progress) — a template
    /// <see cref="MuiInput"/> (Form Field), a Chip Row of insertable
    /// tokens, and a live <see cref="MuiPreviewList"/> of
    /// before/after names recomputed on every keystroke via
    /// <see cref="MuiBatchRenameLogic"/>.
    /// </summary>
    public sealed class MuiBatchRenameModal : ContentControl
    {
        private static readonly IReadOnlyList<MuiChip> TokenChips = new[]
        {
            new MuiChip("{name}", "{name}"), new MuiChip("{ext}", "{ext}"),
            new MuiChip("{date}", "{date}"), new MuiChip("{seq}", "{seq}"),
        };

        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiBatchRenameModal),
                new PropertyMetadata(false, (d, e) => ((MuiBatchRenameModal)d)._shell.IsOpen = (bool)e.NewValue));

        public static readonly DependencyProperty ContainedProperty =
            DependencyProperty.Register(nameof(Contained), typeof(bool), typeof(MuiBatchRenameModal),
                new PropertyMetadata(false, (d, e) => ((MuiBatchRenameModal)d)._shell.Contained = (bool)e.NewValue));

        public static readonly DependencyProperty TemplateProperty =
            DependencyProperty.Register(nameof(Template), typeof(string), typeof(MuiBatchRenameModal),
                new PropertyMetadata("{date}_{seq}", (d, _) => ((MuiBatchRenameModal)d).Rebuild()));

        public static readonly DependencyProperty OriginalsProperty =
            DependencyProperty.Register(nameof(Originals), typeof(IReadOnlyList<string>), typeof(MuiBatchRenameModal),
                new PropertyMetadata(null, (d, _) => ((MuiBatchRenameModal)d).Rebuild()));

        public static readonly DependencyProperty IsRenamingProperty =
            DependencyProperty.Register(nameof(IsRenaming), typeof(bool), typeof(MuiBatchRenameModal),
                new PropertyMetadata(false, (d, _) => ((MuiBatchRenameModal)d).Rebuild()));

        public bool IsOpen { get => (bool)GetValue(IsOpenProperty); set => SetValue(IsOpenProperty, value); }
        public bool Contained { get => (bool)GetValue(ContainedProperty); set => SetValue(ContainedProperty, value); }
        public string Template { get => (string)GetValue(TemplateProperty); set => SetValue(TemplateProperty, value); }

        /// <summary>Original filenames (with extension) being renamed.</summary>
        public IReadOnlyList<string>? Originals
        {
            get => (IReadOnlyList<string>?)GetValue(OriginalsProperty);
            set => SetValue(OriginalsProperty, value);
        }

        public bool IsRenaming { get => (bool)GetValue(IsRenamingProperty); set => SetValue(IsRenamingProperty, value); }

        public event EventHandler? Dismissed;
        public event EventHandler<string>? RenameRequested;

        private readonly MuiOverlayShell _shell = new() { Size = MuiOverlayShellSize.Md, AriaLabel = "Batch Rename" };
        private readonly MuiInput _templateInput = new() { Placeholder = "{date}_{seq}" };
        private readonly MuiChipRow _tokens = new() { Mode = MuiChipRowMode.Select, Chips = TokenChips };
        private readonly MuiPreviewList _preview = new();
        private readonly MuiProgress _progress = new() { IsIndeterminate = true, Visibility = Visibility.Collapsed };
        private readonly MuiButton _cancel = new() { Variant = MuiButtonVariant.Ghost, Label = "Cancel" };
        private readonly MuiButton _rename = new() { Variant = MuiButtonVariant.Primary, Label = "Rename all" };

        public MuiBatchRenameModal()
        {
            var body = new StackPanel { Orientation = Orientation.Vertical, Spacing = 14 };
            body.Children.Add(new MuiFormField { Label = "Template", ControlContent = _templateInput, Help = "Insert a token, or type your own." });
            body.Children.Add(_tokens);
            body.Children.Add(_preview);

            var footer = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
            footer.Children.Add(_progress);
            footer.Children.Add(_cancel);
            footer.Children.Add(_rename);

            _shell.Header = new MuiText { Text = "Batch Rename", Variant = MuiTextVariant.SheetTitle };
            _shell.Body = body;
            _shell.Footer = footer;
            Content = _shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _shell.Dismissed += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _cancel.Click += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _templateInput.TextChanged += (_, text) => Template = text;
            _tokens.SelectionChanged += (_, tokenId) => Template += tokenId;
            _rename.Click += (_, _) => RenameRequested?.Invoke(this, Template);

            Rebuild();
        }

        private static (string Name, string Ext) Split(string filename)
        {
            var dot = filename.LastIndexOf('.');
            return dot < 0 ? (filename, string.Empty) : (filename[..dot], filename[(dot + 1)..]);
        }

        private void Rebuild()
        {
            if (_templateInput.Text != Template) _templateInput.Text = Template;
            _progress.Visibility = IsRenaming ? Visibility.Visible : Visibility.Collapsed;
            _rename.IsEnabled = !IsRenaming;

            var originals = Originals ?? Array.Empty<string>();
            var pairs = originals.Select(Split).ToList();
            var renamed = MuiBatchRenameLogic.PreviewBatch(Template, pairs, DateOnly.FromDateTime(DateTime.Today), 1, 3);
            _preview.Items = originals.Select((original, i) => new MuiPreviewItem(original, original, renamed[i])).ToList();
        }
    }
}
