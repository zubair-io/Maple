using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;
using Windows.ApplicationModel.DataTransfer;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Code Block molecule (unified-component-catalog.md §2.7,
    /// "Code Block" row: "Monospace block with copy", built from Text,
    /// Button) — a monospace block (horizontally scrollable rather than
    /// wrapping, so indentation/alignment survives) with a copy-to-clipboard
    /// button that briefly flips to a "Copied" state after a successful
    /// copy.
    ///
    /// Ports `mui-code-block.component.ts`'s copy/reset contract via
    /// <see cref="Clipboard"/>/<see cref="DataPackage"/> (WinUI's clipboard
    /// API, in place of the web port's `navigator.clipboard`); a denied/
    /// unavailable clipboard is caught the same way — the button silently
    /// stays in its un-copied state rather than throwing into the click
    /// handler.
    /// </summary>
    public sealed class MuiCodeBlock : ContentControl
    {
        private const int CopiedResetMs = 1500;

        public static readonly DependencyProperty CodeProperty =
            DependencyProperty.Register(nameof(Code), typeof(string), typeof(MuiCodeBlock),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiCodeBlock)d).Rebuild()));

        public static readonly DependencyProperty LanguageProperty =
            DependencyProperty.Register(nameof(Language), typeof(string), typeof(MuiCodeBlock),
                new PropertyMetadata(null, (d, _) => ((MuiCodeBlock)d).Rebuild()));

        public string Code
        {
            get => (string)GetValue(CodeProperty);
            set => SetValue(CodeProperty, value);
        }

        /// <summary>An optional language label shown next to the copy
        /// button (e.g. "json", "swift"). Null renders none.</summary>
        public string? Language
        {
            get => (string?)GetValue(LanguageProperty);
            set => SetValue(LanguageProperty, value);
        }

        private readonly Grid _root = new();
        private readonly Border _frame = new() { CornerRadius = new CornerRadius(8), BorderThickness = new Thickness(1), Padding = new Thickness(12, 10, 40, 10) };
        private readonly ScrollViewer _scroll = new()
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Disabled,
            VerticalScrollMode = ScrollMode.Disabled,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollMode = ScrollMode.Enabled,
        };
        private readonly TextBlock _codeText = new() { FontFamily = new FontFamily("Consolas"), FontSize = 12, TextWrapping = TextWrapping.NoWrap };
        private readonly MuiText _languageText = new() { Variant = MuiTextVariant.ToolLabel, ColorRole = MuiTextColorRole.Muted, HorizontalAlignment = HorizontalAlignment.Left, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(12, -4, 0, 0) };
        private readonly MuiButton _copyButton = new()
        {
            Variant = MuiButtonVariant.Ghost,
            ButtonSize = MuiButtonSize.Sm,
            IconName = "copy",
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Top,
            Margin = new Thickness(0, 4, 4, 0),
        };
        private readonly DispatcherTimer _resetTimer = new() { Interval = TimeSpan.FromMilliseconds(CopiedResetMs) };
        private bool _copied;

        public MuiCodeBlock()
        {
            _scroll.Content = _codeText;
            _frame.Child = _scroll;
            _root.Children.Add(_frame);
            _root.Children.Add(_languageText);
            _root.Children.Add(_copyButton);
            Content = _root;
            IsTabStop = false;

            _resetTimer.Tick += (_, _) =>
            {
                _resetTimer.Stop();
                _copied = false;
                RebuildCopyButton();
            };
            _copyButton.Click += (_, _) => Copy();

            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void Copy()
        {
            try
            {
                var package = new DataPackage();
                package.SetText(Code ?? string.Empty);
                Clipboard.SetContent(package);

                _copied = true;
                _resetTimer.Stop();
                _resetTimer.Start();
                RebuildCopyButton();
            }
            catch
            {
                // Clipboard access can be denied (permissions, locked
                // session) — stay in the un-copied state rather than
                // throwing into the click handler.
            }
        }

        private void Rebuild()
        {
            _frame.Background = R("MapleImageCanvas");
            _frame.BorderBrush = R("MapleBorder");
            _codeText.Foreground = R("MapleTextMain");
            _codeText.Text = Code ?? string.Empty;

            _languageText.Text = Language ?? string.Empty;
            _languageText.Visibility = string.IsNullOrEmpty(Language) ? Visibility.Collapsed : Visibility.Visible;

            RebuildCopyButton();
        }

        private void RebuildCopyButton()
        {
            _copyButton.IconName = _copied ? "check" : "copy";
            AutomationProperties.SetName(_copyButton, _copied ? "Copied" : "Copy code");
        }
    }
}
