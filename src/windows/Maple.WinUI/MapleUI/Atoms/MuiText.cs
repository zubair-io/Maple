using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace Maple.UI.Atoms
{
    /// <summary>The nine type-scale steps (text.md § Variants).</summary>
    public enum MuiTextVariant
    {
        SourceTitle, SheetTitle, RowLabel, Body, ToolLabel, ChipLabel, Eyebrow, ValueChip, Filename,
    }

    /// <summary>Text color role (text.md § Props: color).</summary>
    public enum MuiTextColorRole { Main, Muted, OnAccent, Success, Warning, Error }

    /// <summary>
    /// Maple.UI Text atom (docs/design/maple-ui/components/text.md) — the
    /// styled text block every label/caption/title/body copy routes through.
    /// Wraps an internal <see cref="TextBlock"/> (a ContentControl composite,
    /// the same shape MuiButton/MuiLink use) rather than subclassing
    /// TextBlock directly, so this atom's own <see cref="Text"/> property is
    /// free to react to every set (needed for the Eyebrow variant's uppercase
    /// transform) without depending on overriding a built-in DP's metadata.
    /// </summary>
    public sealed class MuiText : ContentControl
    {
        public static readonly DependencyProperty TextProperty =
            DependencyProperty.Register(nameof(Text), typeof(string), typeof(MuiText),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiText)d).Rebuild()));

        public static readonly DependencyProperty VariantProperty =
            DependencyProperty.Register(nameof(Variant), typeof(MuiTextVariant), typeof(MuiText),
                new PropertyMetadata(MuiTextVariant.Body, (d, _) => ((MuiText)d).Rebuild()));

        public static readonly DependencyProperty ColorRoleProperty =
            DependencyProperty.Register(nameof(ColorRole), typeof(MuiTextColorRole), typeof(MuiText),
                new PropertyMetadata(MuiTextColorRole.Main, (d, _) => ((MuiText)d).Rebuild()));

        public static readonly DependencyProperty TruncateProperty =
            DependencyProperty.Register(nameof(Truncate), typeof(bool), typeof(MuiText),
                new PropertyMetadata(false, (d, _) => ((MuiText)d).Rebuild()));

        public static readonly DependencyProperty LineClampProperty =
            DependencyProperty.Register(nameof(LineClamp), typeof(int?), typeof(MuiText),
                new PropertyMetadata(null, (d, _) => ((MuiText)d).Rebuild()));

        public string Text
        {
            get => (string)GetValue(TextProperty);
            set => SetValue(TextProperty, value);
        }

        public MuiTextVariant Variant
        {
            get => (MuiTextVariant)GetValue(VariantProperty);
            set => SetValue(VariantProperty, value);
        }

        public MuiTextColorRole ColorRole
        {
            get => (MuiTextColorRole)GetValue(ColorRoleProperty);
            set => SetValue(ColorRoleProperty, value);
        }

        /// <summary>Single-line ellipsis truncation.</summary>
        public bool Truncate
        {
            get => (bool)GetValue(TruncateProperty);
            set => SetValue(TruncateProperty, value);
        }

        /// <summary>Multi-line clamp before an ellipsis; ignored when
        /// <see cref="Truncate"/> is also set (text.md § Props).</summary>
        public int? LineClamp
        {
            get => (int?)GetValue(LineClampProperty);
            set => SetValue(LineClampProperty, value);
        }

        private readonly TextBlock _inner = new();

        public MuiText()
        {
            Content = _inner;
            IsTabStop = false;
            Rebuild();
        }

        private static string StyleKey(MuiTextVariant variant) => variant switch
        {
            MuiTextVariant.SourceTitle => "MuiTextSourceTitleStyle",
            MuiTextVariant.SheetTitle => "MuiTextSheetTitleStyle",
            MuiTextVariant.RowLabel => "MuiTextRowLabelStyle",
            MuiTextVariant.ToolLabel => "MuiTextToolLabelStyle",
            MuiTextVariant.ChipLabel => "MuiTextChipLabelStyle",
            MuiTextVariant.Eyebrow => "MuiTextEyebrowStyle",
            MuiTextVariant.ValueChip => "MuiTextValueChipStyle",
            MuiTextVariant.Filename => "MuiTextFilenameStyle",
            _ => "MuiTextBodyStyle",
        };

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private static Brush ColorFor(MuiTextColorRole role) => role switch
        {
            MuiTextColorRole.Muted => R("MapleTextMuted"),
            // text.md: no dedicated "on accent" token exists yet — text_main
            // already reads correctly over the primary/error fills used
            // elsewhere (per button.md's primary-fill label color).
            MuiTextColorRole.OnAccent => R("MapleTextMain"),
            MuiTextColorRole.Success => R("MapleSuccessText"),
            MuiTextColorRole.Warning => R("MapleWarn"),
            MuiTextColorRole.Error => R("MapleErrorText"),
            _ => R("MapleTextMain"),
        };

        private void Rebuild()
        {
            _inner.Style = (Style)Application.Current.Resources[StyleKey(Variant)];
            _inner.Foreground = ColorFor(ColorRole);

            // eyebrow (text.md § Variants): "uppercase, wide tracking" — no
            // CSS text-transform equivalent on TextBlock, so the transform is
            // applied to the string itself.
            _inner.Text = Variant == MuiTextVariant.Eyebrow ? (Text ?? string.Empty).ToUpperInvariant() : Text ?? string.Empty;

            if (Truncate)
            {
                _inner.TextTrimming = TextTrimming.CharacterEllipsis;
                _inner.TextWrapping = TextWrapping.NoWrap;
                _inner.MaxLines = 1;
            }
            else if (LineClamp is { } clamp && clamp > 0)
            {
                _inner.TextTrimming = TextTrimming.CharacterEllipsis;
                _inner.TextWrapping = TextWrapping.Wrap;
                _inner.MaxLines = clamp;
            }
            else
            {
                _inner.TextTrimming = TextTrimming.None;
                _inner.TextWrapping = TextWrapping.Wrap;
                _inner.MaxLines = 0;
            }

            // text.md § Accessibility: truncated/clamped text must still be
            // reachable in full — surface it as a tooltip (the closest
            // equivalent this platform has to a `title` attribute) whenever
            // truncation is active, so the tail isn't silently lost.
            if (Truncate || LineClamp is > 0)
                ToolTipService.SetToolTip(_inner, Text);
            else
                ToolTipService.SetToolTip(_inner, null);
        }
    }
}
