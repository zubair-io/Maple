using System;
using System.Collections.Generic;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One inserted embed card shown below the prose body.</summary>
    public sealed record MuiRichTextEmbed(string Title, string Url);

    /// <summary>
    /// Maple.UI Rich Text Editor organism (unified-component-catalog.md
    /// §4.5, "Rich Text Editor" row: "Structured document editing", built
    /// from Bubble Menu, Command Menu, Suggestion Menu, Embed Shell, Code
    /// Block) — a <see cref="RichEditBox"/> body (this wave's brief calls
    /// for staying conservative rather than a bespoke block-editor
    /// model): a selection-triggered <see cref="MuiBubbleMenu"/>
    /// (Bold/Italic on the live selection), an Insert
    /// <see cref="MuiCommandMenu"/> (Heading/Bullet List/Code Block
    /// prefixes at the caret), an @-mention <see cref="MuiSuggestionMenu"/>,
    /// inserted embeds rendered as <see cref="MuiEmbedShell"/> cards below
    /// the body, and an optional <see cref="MuiCodeBlock"/> preview paired
    /// with a plain edit <see cref="MuiInput"/> for its source (Code Block
    /// itself has no editable surface of its own).
    /// </summary>
    public sealed class MuiRichTextEditor : ContentControl
    {
        public static readonly DependencyProperty ValueProperty =
            DependencyProperty.Register(nameof(Value), typeof(string), typeof(MuiRichTextEditor),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiRichTextEditor)d).OnValuePropertyChanged((string)e.NewValue)));

        public static readonly DependencyProperty MentionSuggestionsProperty =
            DependencyProperty.Register(nameof(MentionSuggestions), typeof(IReadOnlyList<MuiSuggestionItem>), typeof(MuiRichTextEditor),
                new PropertyMetadata(null, (d, e) => ((MuiRichTextEditor)d)._mentions.Items = (IReadOnlyList<MuiSuggestionItem>?)e.NewValue));

        public static readonly DependencyProperty EmbedsProperty =
            DependencyProperty.Register(nameof(Embeds), typeof(IReadOnlyList<MuiRichTextEmbed>), typeof(MuiRichTextEditor),
                new PropertyMetadata(null, (d, _) => ((MuiRichTextEditor)d).RebuildEmbeds()));

        public static readonly DependencyProperty CodeValueProperty =
            DependencyProperty.Register(nameof(CodeValue), typeof(string), typeof(MuiRichTextEditor),
                new PropertyMetadata(string.Empty, (d, e) =>
                {
                    var self = (MuiRichTextEditor)d;
                    var value = (string)e.NewValue;
                    self._codeInput.Text = value;
                    self._codePreview.Code = value;
                }));

        public static readonly DependencyProperty ShowCodeBlockProperty =
            DependencyProperty.Register(nameof(ShowCodeBlock), typeof(bool), typeof(MuiRichTextEditor),
                new PropertyMetadata(false, (d, e) => ((MuiRichTextEditor)d)._codeSection.Visibility = (bool)e.NewValue ? Visibility.Visible : Visibility.Collapsed));

        public string Value { get => (string)GetValue(ValueProperty); set => SetValue(ValueProperty, value); }

        public IReadOnlyList<MuiSuggestionItem>? MentionSuggestions
        {
            get => (IReadOnlyList<MuiSuggestionItem>?)GetValue(MentionSuggestionsProperty);
            set => SetValue(MentionSuggestionsProperty, value);
        }

        public IReadOnlyList<MuiRichTextEmbed>? Embeds
        {
            get => (IReadOnlyList<MuiRichTextEmbed>?)GetValue(EmbedsProperty);
            set => SetValue(EmbedsProperty, value);
        }

        public string CodeValue { get => (string)GetValue(CodeValueProperty); set => SetValue(CodeValueProperty, value); }
        public bool ShowCodeBlock { get => (bool)GetValue(ShowCodeBlockProperty); set => SetValue(ShowCodeBlockProperty, value); }

        public event EventHandler<string>? ValueChanged;
        public event EventHandler<string>? MentionInserted;
        public event EventHandler? EmbedRequested;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 10 };
        private readonly StackPanel _toolbar = new() { Orientation = Orientation.Horizontal, Spacing = 4 };
        private readonly MuiButton _boldButton = new() { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm, IconName = "tool-bw", Label = "Bold" };
        private readonly MuiButton _italicButton = new() { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm, Label = "Italic" };
        private readonly MuiButton _mentionButton = new() { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm, Label = "@Mention" };
        private readonly MuiButton _insertButton = new() { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm, Label = "Insert…" };
        private readonly MuiButton _embedButton = new() { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm, Label = "Embed" };
        private readonly Grid _editorHost = new();
        private readonly RichEditBox _editor = new() { MinHeight = 140, AcceptsReturn = true };
        private readonly MuiBubbleMenu _bubbleMenu = new()
        {
            Entries = new[]
            {
                MuiBubbleMenuEntry.For(new MuiBubbleMenuItem("bold", "tool-bw", "Bold")),
                MuiBubbleMenuEntry.For(new MuiBubbleMenuItem("italic", "edit", "Italic")),
            },
        };
        private readonly Grid _mentionAnchor = new();
        private readonly MuiSuggestionMenu _mentions = new();
        private readonly Grid _insertAnchor = new();
        private readonly MuiCommandMenu _insertMenu = new()
        {
            Commands = new[]
            {
                new MuiCommandItem("heading", "Heading"), new MuiCommandItem("bullet", "Bullet list"), new MuiCommandItem("code", "Code block"),
            },
        };
        private readonly StackPanel _embedList = new() { Orientation = Orientation.Vertical, Spacing = 8 };
        private readonly StackPanel _codeSection = new() { Orientation = Orientation.Vertical, Spacing = 6, Visibility = Visibility.Collapsed };
        private readonly MuiInput _codeInput = new() { Placeholder = "Code" };
        private readonly MuiCodeBlock _codePreview = new() { Language = "text" };
        private bool _suppressValueCallback;

        public MuiRichTextEditor()
        {
            _toolbar.Children.Add(_boldButton);
            _toolbar.Children.Add(_italicButton);
            _toolbar.Children.Add(_mentionButton);
            _toolbar.Children.Add(_insertButton);
            _toolbar.Children.Add(_embedButton);

            _mentionAnchor.Children.Add(_toolbar);
            _mentionAnchor.Children.Add(_mentions);
            _insertAnchor.Children.Add(_mentionAnchor);
            _insertAnchor.Children.Add(_insertMenu);

            _editorHost.Children.Add(_editor);
            _editorHost.Children.Add(_bubbleMenu);

            _codeSection.Children.Add(_codeInput);
            _codeSection.Children.Add(_codePreview);

            _root.Children.Add(_insertAnchor);
            _root.Children.Add(_editorHost);
            _root.Children.Add(_codeSection);
            _root.Children.Add(_embedList);
            Content = _root;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;

            _boldButton.Click += (_, _) => ToggleCharacterFormat(f => f.Bold = FormatEffect.Toggle);
            _italicButton.Click += (_, _) => ToggleCharacterFormat(f => f.Italic = FormatEffect.Toggle);
            _mentionButton.Click += (_, _) => _mentions.IsOpen = true;
            _insertButton.Click += (_, _) => _insertMenu.IsOpen = true;
            _embedButton.Click += (_, _) => EmbedRequested?.Invoke(this, EventArgs.Empty);
            _mentions.ItemSelected += (_, id) => { InsertText($"@{id} "); _mentions.IsOpen = false; MentionInserted?.Invoke(this, id); };
            _mentions.CloseRequested += (_, _) => _mentions.IsOpen = false;
            _insertMenu.ItemSelected += OnInsertCommand;
            _insertMenu.CloseRequested += (_, _) => _insertMenu.IsOpen = false;
            _bubbleMenu.ItemSelected += OnBubbleMenuItem;
            _bubbleMenu.CloseRequested += (_, _) => _bubbleMenu.IsOpen = false;
            _codeInput.TextChanged += (_, text) => CodeValue = text;

            _editor.SelectionChanged += (_, _) => _bubbleMenu.IsOpen = _editor.Document.Selection.Length != 0;
            _editor.TextChanged += (_, _) =>
            {
                _editor.Document.GetText(TextGetOptions.None, out var text);
                _suppressValueCallback = true;
                Value = text;
                _suppressValueCallback = false;
                ValueChanged?.Invoke(this, text);
            };

            RebuildEmbeds();
        }

        private void ToggleCharacterFormat(Action<ITextCharacterFormat> apply) => apply(_editor.Document.Selection.CharacterFormat);

        private void OnBubbleMenuItem(object? sender, string id)
        {
            if (id == "bold") ToggleCharacterFormat(f => f.Bold = FormatEffect.Toggle);
            else if (id == "italic") ToggleCharacterFormat(f => f.Italic = FormatEffect.Toggle);
            _bubbleMenu.IsOpen = false;
        }

        private void OnInsertCommand(object? sender, string id)
        {
            _insertMenu.IsOpen = false;
            switch (id)
            {
                case "heading": InsertText("# "); break;
                case "bullet": InsertText("• "); break;
                case "code": ShowCodeBlock = true; break;
            }
        }

        private void InsertText(string text)
        {
            _editor.Document.Selection.SetText(TextSetOptions.None, text);
            _editor.Document.Selection.StartPosition = _editor.Document.Selection.EndPosition;
        }

        private void OnValuePropertyChanged(string value)
        {
            if (!_suppressValueCallback) _editor.Document.SetText(TextSetOptions.None, value ?? string.Empty);
        }

        private void RebuildEmbeds()
        {
            _embedList.Children.Clear();
            foreach (var embed in Embeds ?? Array.Empty<MuiRichTextEmbed>())
                _embedList.Children.Add(new MuiEmbedShell { Title = embed.Title, StatusIconName = "share-up-square", StatusLabel = embed.Url });
        }
    }
}
