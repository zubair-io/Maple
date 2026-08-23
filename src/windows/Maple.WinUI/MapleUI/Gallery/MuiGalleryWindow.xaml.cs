using System;
using System.Collections.Generic;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using Maple.UI.Atoms;

namespace Maple.UI.Gallery
{
    /// <summary>
    /// Maple.UI Gallery window — a showcase for the Maple.UI control library
    /// (docs/unified-component-catalog.md), organized by the catalog's own
    /// tiers. Tokens, Atoms, Molecules L1, and Molecules L2 render live
    /// specimens built from the actual Maple.UI controls; the remaining
    /// tiers (nothing has been built for them yet, per the catalog's
    /// design order) render as plain name lists pulled from the catalog,
    /// so the gallery already has a home for each tier as later waves land.
    /// </summary>
    public sealed partial class MuiGalleryWindow : Window
    {
        private Dictionary<string, ScrollViewer> _pages = null!;
        private Dictionary<string, Button> _tabs = null!;

        public MuiGalleryWindow()
        {
            InitializeComponent();

            try
            {
                AppWindow.Resize(new Windows.Graphics.SizeInt32(1100, 780));
            }
            catch
            {
                // Sizing is a convenience only — an unexpected host window
                // configuration must not prevent the gallery from opening.
            }

            _pages = new Dictionary<string, ScrollViewer>
            {
                ["Tokens"] = TokensPage,
                ["Atoms"] = AtomsPage,
                ["MoleculesL1"] = MoleculesL1Page,
                ["MoleculesL2"] = MoleculesL2Page,
                ["Organisms"] = OrganismsPage,
                ["Templates"] = TemplatesPage,
                ["Pages"] = PagesPage,
            };
            _tabs = new Dictionary<string, Button>
            {
                ["Tokens"] = TabTokens,
                ["Atoms"] = TabAtoms,
                ["MoleculesL1"] = TabMoleculesL1,
                ["MoleculesL2"] = TabMoleculesL2,
                ["Organisms"] = TabOrganisms,
                ["Templates"] = TabTemplates,
                ["Pages"] = TabPages,
            };

            BuildTokensPage();
            BuildAtomsPage();
            BuildMoleculesL1Page(MoleculesL1Panel);
            BuildMoleculesL2Page(MoleculesL2Panel);
            BuildPlaceholderPage(OrganismsPanel, "Organisms", OrganismNames);
            BuildPlaceholderPage(TemplatesPanel, "Templates", TemplateNames);
            BuildPlaceholderPage(PagesPanel, "Pages", PageNames);

            SelectTab("Tokens");
        }

        private void OnTabClick(object sender, RoutedEventArgs e)
        {
            if (sender is Button { Tag: string key })
                SelectTab(key);
        }

        private void SelectTab(string key)
        {
            foreach (var pair in _pages)
                pair.Value.Visibility = pair.Key == key ? Visibility.Visible : Visibility.Collapsed;

            foreach (var pair in _tabs)
            {
                var selected = pair.Key == key;
                pair.Value.Background = selected
                    ? R("MapleSurfaceHover")
                    : new SolidColorBrush(Microsoft.UI.Colors.Transparent);
                pair.Value.Foreground = selected ? R("MapleTextMain") : R("MapleTextMuted");
                pair.Value.BorderThickness = new Thickness(0);
            }
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        // ─────────────────────────── Tokens page ───────────────────────────

        private static readonly string[] ColorTokenKeys =
        {
            "MapleBg", "MapleSurface", "MapleSurfaceAlt", "MapleSurfaceHover", "MapleSidebar",
            "MapleInputBg", "MapleImageCanvas", "MapleTextMain", "MapleTextMuted", "MapleBorder",
            "MapleBorderHi", "MaplePrimary", "MaplePrimaryDim", "MapleWarn", "MapleBgHover",
            "MapleBgActive", "MapleSuccessBg", "MapleSuccessText", "MapleErrorBg", "MapleErrorText",
            "MapleStar",
        };

        private static readonly (string Name, double Px)[] RadiusTokens =
        {
            ("MapleRadiusXs", 4), ("MapleRadiusSm", 6), ("MapleRadiusMd", 8),
            ("MapleRadiusLg", 12), ("MapleRadiusXl", 16), ("MapleRadiusXxl", 24),
            ("MapleRadiusFull", 9999),
        };

        private static readonly (string Name, double Px)[] SpacingTokens =
        {
            ("MapleSpacingXs", 4), ("MapleSpacingSm", 8), ("MapleSpacingMd", 16),
            ("MapleSpacingLg", 24), ("MapleSpacingXl", 32), ("MapleSpacingXxl", 48),
        };

        private void BuildTokensPage()
        {
            TokensPanel.Children.Add(SectionHeading("Color"));
            var swatchGrid = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 16 };
            var wrap = new WrapPanelLike();
            foreach (var key in ColorTokenKeys)
                wrap.Add(ColorSwatch(key));
            TokensPanel.Children.Add(wrap.Root);

            TokensPanel.Children.Add(SectionHeading("Radius"));
            TokensPanel.Children.Add(ValueRows(RadiusTokens));

            TokensPanel.Children.Add(SectionHeading("Spacing"));
            TokensPanel.Children.Add(ValueRows(SpacingTokens));
        }

        private static UIElement ColorSwatch(string colorKey)
        {
            var col = new StackPanel { Orientation = Orientation.Vertical, Spacing = 6, Width = 96 };
            col.Children.Add(new Border
            {
                Width = 72,
                Height = 72,
                CornerRadius = new CornerRadius(8),
                Background = R(colorKey),
                BorderBrush = R("MapleBorder"),
                BorderThickness = new Thickness(1),
            });
            col.Children.Add(new TextBlock
            {
                Text = colorKey,
                FontSize = 11,
                Foreground = R("MapleTextMuted"),
                TextWrapping = TextWrapping.Wrap,
            });
            return col;
        }

        private static UIElement ValueRows((string Name, double Px)[] tokens)
        {
            var list = new StackPanel { Orientation = Orientation.Vertical, Spacing = 6 };
            foreach (var (name, px) in tokens)
            {
                var row = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12 };
                row.Children.Add(new TextBlock
                {
                    Text = name,
                    Width = 200,
                    FontSize = 13,
                    Foreground = R("MapleTextMain"),
                });
                row.Children.Add(new TextBlock
                {
                    Text = px >= 9999 ? "full" : $"{px:0}px",
                    FontSize = 13,
                    FontFamily = new FontFamily("Consolas"),
                    Foreground = R("MapleTextMuted"),
                });
                list.Children.Add(row);
            }
            return list;
        }

        private static TextBlock SectionHeading(string text) => new()
        {
            Text = text,
            FontSize = 17,
            FontWeight = Microsoft.UI.Text.FontWeights.Bold,
            Foreground = R("MapleTextMain"),
        };

        /// <summary>Wraps children across lines without depending on the
        /// WinUI Community Toolkit's WrapPanel (not referenced by this
        /// project) — a plain vertical stack of horizontal rows, rebalanced
        /// at a fixed column count. Good enough for a fixed 21-item token
        /// swatch list; not a general-purpose layout primitive.</summary>
        private sealed class WrapPanelLike
        {
            private const int ColumnsPerRow = 6;
            public StackPanel Root { get; } = new() { Orientation = Orientation.Vertical, Spacing = 16 };
            private StackPanel? _currentRow;
            private int _count;

            public void Add(UIElement element)
            {
                if (_currentRow == null || _count % ColumnsPerRow == 0)
                {
                    _currentRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 16 };
                    Root.Children.Add(_currentRow);
                }
                _currentRow.Children.Add(element);
                _count++;
            }
        }

        // ─────────────────────────── Atoms page ───────────────────────────

        private void BuildAtomsPage()
        {
            var sampleTime = DateTimeOffset.Now.AddHours(-3).AddMinutes(-12);
            var now = DateTimeOffset.Now;

            AtomsPanel.Children.Add(SpecimenCard("Button", "Text action, optional icon.", Row(
                new MuiButton { Variant = MuiButtonVariant.Primary, Label = "Save" },
                new MuiButton { Variant = MuiButtonVariant.Secondary, Label = "Cancel" },
                new MuiButton { Variant = MuiButtonVariant.Ghost, Label = "More", IconName = "ellipsis-horizontal" },
                new MuiButton { Variant = MuiButtonVariant.Destructive, Label = "Delete" },
                new MuiButton { Variant = MuiButtonVariant.Primary, Label = "Disabled", IsEnabled = false },
                new MuiButton { Variant = MuiButtonVariant.Primary, Label = "Loading", IsLoading = true })));

            AtomsPanel.Children.Add(SpecimenCard("Action Button", "Compact icon+label pill for toolbars.", Row(
                new MuiActionButton { IconName = "tool-exposure", Label = "Exposure" },
                new MuiActionButton { IconName = "tool-contrast", Label = "Contrast", Selected = true },
                new MuiActionButton { IconName = "tool-crop", Label = "Crop", Orientation = MuiActionButtonOrientation.Stacked })));

            AtomsPanel.Children.Add(SpecimenCard("Icon", "Single glyph, five size steps.", Row(
                new MuiIcon { IconName = "star-filled", Size = MuiIconSize.Xs14 },
                new MuiIcon { IconName = "star-filled", Size = MuiIconSize.Sm16 },
                new MuiIcon { IconName = "star-filled", Size = MuiIconSize.Md24 },
                new MuiIcon { IconName = "star-filled", Size = MuiIconSize.Lg30 },
                new MuiIcon { IconName = "star-filled", Size = MuiIconSize.Xl36 })));

            AtomsPanel.Children.Add(SpecimenCard("Link", "Inline hyperlink, internal vs. external.", Row(
                new MuiLink { Label = "View details", Href = "maple-app://details" },
                new MuiLink { Label = "Open documentation", Href = "https://justmaple.app/docs", External = true })));

            AtomsPanel.Children.Add(SpecimenCard("Text", "The full type scale.", Column(
                new MuiText { Text = "Source title", Variant = MuiTextVariant.SourceTitle },
                new MuiText { Text = "Sheet title", Variant = MuiTextVariant.SheetTitle },
                new MuiText { Text = "Row label", Variant = MuiTextVariant.RowLabel },
                new MuiText { Text = "Body copy reads at this size.", Variant = MuiTextVariant.Body },
                new MuiText { Text = "Section kicker", Variant = MuiTextVariant.Eyebrow },
                new MuiText { Text = "DSC_0192.dng", Variant = MuiTextVariant.Filename })));

            AtomsPanel.Children.Add(SpecimenCard("Timestamp", "Formatted date/time, four formats.", Row(
                new MuiTimestamp { Value = sampleTime, Now = now, Format = MuiTimestampFormat.Relative },
                new MuiTimestamp { Value = sampleTime, Now = now, Format = MuiTimestampFormat.Short },
                new MuiTimestamp { Value = sampleTime, Now = now, Format = MuiTimestampFormat.Long },
                new MuiTimestamp { Value = sampleTime, Now = now, Format = MuiTimestampFormat.TimeOnly })));

            AtomsPanel.Children.Add(SpecimenCard("Badge", "Small filled status/count indicator.", Row(
                new MuiBadge { Variant = MuiBadgeVariant.Count, Value = "3", Label = "3 unread" },
                new MuiBadge { Variant = MuiBadgeVariant.Signal, Value = "Needs review" },
                new MuiBadge { Variant = MuiBadgeVariant.Rating, Value = "4.8" })));

            AtomsPanel.Children.Add(SpecimenCard("Stat", "Labeled numeric value with optional delta.", Row(
                new MuiStat { Value = "1,284", Label = "Photos", StatSize = MuiStatSize.Lg, Delta = "+42", Trend = MuiStatTrend.Up },
                new MuiStat { Value = "12", Label = "Selected", StatSize = MuiStatSize.Sm })));

            AtomsPanel.Children.Add(SpecimenCard("Divider", "1px hairline separator.", new StackPanel
            {
                Orientation = Orientation.Vertical,
                Spacing = 12,
                Children =
                {
                    new MuiDivider { Orientation = MuiDividerOrientation.Horizontal },
                    new StackPanel
                    {
                        Orientation = Orientation.Horizontal,
                        Height = 32,
                        Spacing = 12,
                        Children =
                        {
                            new TextBlock { Text = "Left", Foreground = R("MapleTextMain"), VerticalAlignment = VerticalAlignment.Center },
                            new MuiDivider { Orientation = MuiDividerOrientation.Vertical },
                            new TextBlock { Text = "Right", Foreground = R("MapleTextMain"), VerticalAlignment = VerticalAlignment.Center },
                        },
                    },
                },
            }));

            AtomsPanel.Children.Add(SpecimenCard("List", "Ordered / unordered items, nesting indent.", new MuiList
            {
                Marker = MuiListMarker.Disc,
                Items = new List<MuiListItem>
                {
                    new("Load the RAW file"),
                    new("Apply the base curve", new List<MuiListItem> { new("Verify against the ACR reference") }),
                    new("Export the sidecar"),
                },
            }));

            // ─────────────── Wave 2: Form / Media / Feedback ───────────────

            AtomsPanel.Children.Add(SpecimenCard("Input", "Single-line text field, sizes, states, numeric variant.", Column(
                new MuiInput { Placeholder = "Filename", Text = "DSC_0192" },
                new MuiInput { Variant = MuiInputVariant.Search, Placeholder = "Search library" },
                new MuiInput { Placeholder = "Read-only", Text = "app.justmaple.aperture", ReadOnly = true },
                new MuiInput { Placeholder = "Client ID", Error = "This field is required", InputSize = MuiInputSize.Sm },
                new MuiInput { Placeholder = "Disabled", IsEnabled = false },
                new MuiInput { Variant = MuiInputVariant.Numeric, NumericValue = 50, Minimum = 0, Maximum = 100 })));

            AtomsPanel.Children.Add(SpecimenCard("Checkbox", "Binary / tri-state selection.", Column(
                new MuiCheckbox { Label = "Include sidecars", CheckedState = true },
                new MuiCheckbox { Label = "Overwrite existing", CheckedState = false },
                new MuiCheckbox { Label = "Some selected", CheckedState = null },
                new MuiCheckbox { Label = "Disabled", IsEnabled = false })));

            AtomsPanel.Children.Add(SpecimenCard("Segmented Toggle", "2-3 exclusive options, animated selection pill.", Row(
                new MuiSegmentedToggle
                {
                    Width = 160,
                    Options = new List<MuiSegmentedToggleOption> { new("Fit"), new("Fill") },
                    SelectedIndex = 0,
                },
                new MuiSegmentedToggle
                {
                    Width = 220,
                    Options = new List<MuiSegmentedToggleOption> { new("Grid"), new("Filmstrip"), new("Map") },
                    SelectedIndex = 1,
                })));

            AtomsPanel.Children.Add(SpecimenCard("Image", "Raster leaf, fit modes, broken-state fallback.", Row(
                new MuiImage { Width = 96, Height = 72, ImageCornerRadius = 8, Fit = MuiImageFit.Fill, Source = SolidBitmap(0x9C, 0x6A, 0xC4) },
                new MuiImage { Width = 96, Height = 72, ImageCornerRadius = 8, Source = null })));

            AtomsPanel.Children.Add(SpecimenCard("Remote Image", "Tiered thumb -> preview -> full load, retry affordance.", Row(
                new MuiRemoteImage
                {
                    Width = 96,
                    Height = 72,
                    ImageCornerRadius = 8,
                    Loader = new MuiRemoteImageLoader<ImageSource>((_, _) => new TaskCompletionSource<ImageSource>().Task),
                },
                new MuiRemoteImage
                {
                    Width = 96,
                    Height = 72,
                    ImageCornerRadius = 8,
                    Loader = new MuiRemoteImageLoader<ImageSource>((_, _) =>
                        Task.FromException<ImageSource>(new InvalidOperationException("network unavailable (gallery demo)"))),
                })));

            AtomsPanel.Children.Add(SpecimenCard("Avatar", "Initials fallback, deterministic palette, presence dot.", Row(
                new MuiAvatar { Name = "Ada Lovelace", AvatarSize = MuiAvatarSize.Sm },
                new MuiAvatar { Name = "Grace Hopper", AvatarSize = MuiAvatarSize.Md, Presence = MuiAvatarPresence.Online },
                new MuiAvatar { Name = "Cher", AvatarSize = MuiAvatarSize.Lg, Presence = MuiAvatarPresence.Away })));

            AtomsPanel.Children.Add(SpecimenCard("QR Code", "Deterministic placeholder pattern (no real QR dep this wave — see #3012).", Row(
                new MuiQrPlaceholder { Payload = "maple-app://pair/abc123", PlaceholderSize = MuiQrPlaceholderSize.Sm },
                new MuiQrPlaceholder { Payload = "maple-app://pair/xyz789", PlaceholderSize = MuiQrPlaceholderSize.Md })));

            AtomsPanel.Children.Add(SpecimenCard("Canvas Surface", "Letterbox host for a GPU-rendered layer, loading state.", Row(
                new MuiCanvasSurface { Width = 160, Height = 100, IsLoading = true },
                new MuiCanvasSurface
                {
                    Width = 160,
                    Height = 100,
                    IsLoading = false,
                    HostedContent = new TextBlock
                    {
                        Text = "hosted content",
                        Foreground = R("MapleTextMuted"),
                        HorizontalAlignment = HorizontalAlignment.Center,
                        VerticalAlignment = VerticalAlignment.Center,
                    },
                })));

            AtomsPanel.Children.Add(SpecimenCard("Progress", "Determinate / indeterminate, bar and ring shapes.", Row(
                new MuiProgress { Width = 140, Value = 62, Label = "62%" },
                new MuiProgress { Width = 140, IsIndeterminate = true },
                new MuiProgress { ProgressShape = MuiProgressShape.Ring, Value = 40 },
                new MuiProgress { ProgressShape = MuiProgressShape.Ring, IsIndeterminate = true })));

            AtomsPanel.Children.Add(SpecimenCard("Spinner", "Small indeterminate indicator, delay-before-show.", Row(
                new MuiSpinner { IsSpinning = true, SpinnerSize = MuiSpinnerSize.Sm, DelayMs = 0 },
                new MuiSpinner { IsSpinning = true, SpinnerSize = MuiSpinnerSize.Md, DelayMs = 0 })));

            AtomsPanel.Children.Add(SpecimenCard("Status Text", "Persistence / sync state line, icon pairing.", Column(
                new MuiStatusText { State = MuiStatusTextState.Saving },
                new MuiStatusText { State = MuiStatusTextState.Saved },
                new MuiStatusText { State = MuiStatusTextState.Offline },
                new MuiStatusText { State = MuiStatusTextState.Error })));

            AtomsPanel.Children.Add(SpecimenCard("Toast", "Transient notification, variants, optional action.", Column(
                new MuiToast { Variant = MuiToastVariant.Info, Message = "Sync will resume when you're back online." },
                new MuiToast { Variant = MuiToastVariant.Success, Message = "Export complete.", ActionLabel = "Reveal" },
                new MuiToast { Variant = MuiToastVariant.Warning, Message = "3 files were skipped (duplicates)." },
                new MuiToast { Variant = MuiToastVariant.Error, Message = "Couldn't reach the server.", ActionLabel = "Retry" })));
        }

        /// <summary>A tiny flat-color bitmap for the Image specimen's
        /// "loaded" state — this gallery ships no bundled sample photo, so a
        /// synthesized swatch stands in. Same PixelBuffer-write approach
        /// Controls/ColorWheelControl.cs's BuildDiscBitmap already uses.</summary>
        private static WriteableBitmap SolidBitmap(byte r, byte g, byte b)
        {
            const int size = 8;
            var bmp = new WriteableBitmap(size, size);
            var pixels = new byte[size * size * 4];
            for (var i = 0; i < pixels.Length; i += 4)
            {
                pixels[i] = b;
                pixels[i + 1] = g;
                pixels[i + 2] = r;
                pixels[i + 3] = 255;
            }
            using (var stream = bmp.PixelBuffer.AsStream())
                stream.Write(pixels, 0, pixels.Length);
            return bmp;
        }

        private static StackPanel Row(params UIElement[] children)
        {
            var panel = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 12 };
            foreach (var child in children)
                panel.Children.Add(child);
            return panel;
        }

        private static StackPanel Column(params UIElement[] children)
        {
            var panel = new StackPanel { Orientation = Orientation.Vertical, Spacing = 8 };
            foreach (var child in children)
                panel.Children.Add(child);
            return panel;
        }

        private static Border SpecimenCard(string name, string purpose, UIElement content)
        {
            var body = new StackPanel { Orientation = Orientation.Vertical, Spacing = 12 };
            body.Children.Add(new TextBlock
            {
                Text = name,
                FontSize = 14,
                FontWeight = Microsoft.UI.Text.FontWeights.Bold,
                Foreground = R("MapleTextMain"),
            });
            body.Children.Add(new TextBlock
            {
                Text = purpose,
                FontSize = 12,
                Foreground = R("MapleTextMuted"),
                TextWrapping = TextWrapping.Wrap,
            });
            body.Children.Add(content);

            return new Border
            {
                Background = R("MapleSurface"),
                BorderBrush = R("MapleBorder"),
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(12),
                Padding = new Thickness(20),
                Child = body,
            };
        }

        // ───────────────────── Placeholder tier pages ─────────────────────

        private void BuildPlaceholderPage(StackPanel panel, string title, string[] names)
        {
            panel.Children.Add(new TextBlock
            {
                Text = title,
                FontSize = 17,
                FontWeight = Microsoft.UI.Text.FontWeights.Bold,
                Foreground = R("MapleTextMain"),
                Margin = new Thickness(0, 0, 0, 4),
            });
            panel.Children.Add(new TextBlock
            {
                Text = "Not built yet — names pulled from docs/unified-component-catalog.md.",
                FontSize = 12,
                Foreground = R("MapleTextMuted"),
                Margin = new Thickness(0, 0, 0, 8),
            });
            foreach (var name in names)
            {
                panel.Children.Add(new Border
                {
                    Background = R("MapleSurface"),
                    BorderBrush = R("MapleBorder"),
                    BorderThickness = new Thickness(1),
                    CornerRadius = new CornerRadius(8),
                    Padding = new Thickness(12, 8, 12, 8),
                    Child = new TextBlock { Text = name, FontSize = 13, Foreground = R("MapleTextMain") },
                });
            }
        }

        // docs/unified-component-catalog.md § 2.1-2.7 (all 44 Level-1 molecules)
        // are no longer here — they're built live in MuiGalleryWindow.MoleculesL1*.cs.

        // docs/unified-component-catalog.md § 3 (all 24 Level-2 molecules)
        // are no longer here — they're built live in MuiGalleryWindow.MoleculesL2*.cs.

        // docs/unified-component-catalog.md § 4 (52 organisms).
        private static readonly string[] OrganismNames =
        {
            "Collection Grid", "List View", "Timeline", "Kanban Board", "Filmstrip", "Search Results",
            "Sidebar", "Tool Dock", "Search", "Filter Panel", "Inspector Panel", "Info Panel",
            "Enrichment Panel", "Adjustments Panel", "Color Grading Panel", "HSL Panel",
            "Tone Curve Panel", "Film Panel", "Presets Panel", "Scopes Panel", "Backlinks Panel",
            "Version History Panel", "Thread Panel", "Export", "Batch Rename", "Batch Metadata",
            "Move To", "Panorama Merge", "Selective Paste", "Library Picker", "Add Server",
            "Pair Device", "Share", "Template Gallery", "Card Detail", "Result Report", "Image Canvas",
            "Crop Overlay", "Crop Toolbar", "Control Surface", "Mobile Control Bar", "Rich Text Editor",
            "Whiteboard Canvas", "Structured Data Editor", "Preview Surface", "Map Surface", "Chat",
            "Notification Feed", "Settings Section", "Pipeline Monitor", "Setup Wizard",
            "User Management", "Device List", "Backup Monitor", "Diagnostics",
        };

        // docs/unified-component-catalog.md § 5 (7 templates).
        private static readonly string[] TemplateNames =
        {
            "App Shell", "Split Layout", "Tab Shell", "Settings Shell", "Overlay Shell", "Sheet Shell",
            "Drawer Shell",
        };

        // docs/unified-component-catalog.md § 6 (15 page types).
        private static readonly string[] PageNames =
        {
            "Browse", "Editor", "Document", "Preview", "Search", "Board", "Chat", "Notifications",
            "Settings", "Admin", "Sign In", "Pairing", "TV Timeline", "TV Viewer", "TV Map",
        };
    }
}
