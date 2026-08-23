using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One toggle in a Bubble Menu (e.g. a bold/italic/link format
    /// action).</summary>
    public sealed record MuiBubbleMenuItem(string Id, string IconName, string Label, bool Active = false);

    /// <summary>One entry in a Bubble Menu's row — either an item or a
    /// divider marker (a null <see cref="Item"/>).</summary>
    public readonly record struct MuiBubbleMenuEntry(MuiBubbleMenuItem? Item)
    {
        public bool IsDivider => Item is null;
        public static MuiBubbleMenuEntry Divider() => new(null);
        public static MuiBubbleMenuEntry For(MuiBubbleMenuItem item) => new(item);
    }

    /// <summary>
    /// Maple.UI Bubble Menu molecule (unified-component-catalog.md §2.5,
    /// "Bubble Menu" row: "Floating contextual format bar", built from
    /// Icon, Divider) — a row of icon-only <see cref="MuiActionButton"/>
    /// toggles anchored via <see cref="MuiPopover"/> (default placement
    /// Top, matching `mui-bubble-menu.component.ts`'s own default — a
    /// format bar floats ABOVE the selection it acts on).
    ///
    /// Unlike Context/Suggestion/Command Menu, each item's
    /// <see cref="MuiBubbleMenuItem.Active"/> flag is real toggle state the
    /// HOST owns (e.g. "is the current selection bold") — this control just
    /// reflects it and reports presses; it never resets a button's toggle
    /// visual after a click the way <see cref="MuiToolbar"/> does for its
    /// momentary-press actions.
    /// </summary>
    public sealed class MuiBubbleMenu : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiBubbleMenu),
                new PropertyMetadata(false, (d, e) => ((MuiBubbleMenu)d)._popover.IsOpen = (bool)e.NewValue));

        public static readonly DependencyProperty PlacementProperty =
            DependencyProperty.Register(nameof(Placement), typeof(MuiPopoverPlacement), typeof(MuiBubbleMenu),
                new PropertyMetadata(MuiPopoverPlacement.Top, (d, e) => ((MuiBubbleMenu)d)._popover.Placement = (MuiPopoverPlacement)e.NewValue));

        public static readonly DependencyProperty EntriesProperty =
            DependencyProperty.Register(nameof(Entries), typeof(IReadOnlyList<MuiBubbleMenuEntry>), typeof(MuiBubbleMenu),
                new PropertyMetadata(null, (d, _) => ((MuiBubbleMenu)d).Rebuild()));

        public bool IsOpen
        {
            get => (bool)GetValue(IsOpenProperty);
            set => SetValue(IsOpenProperty, value);
        }

        public MuiPopoverPlacement Placement
        {
            get => (MuiPopoverPlacement)GetValue(PlacementProperty);
            set => SetValue(PlacementProperty, value);
        }

        public IReadOnlyList<MuiBubbleMenuEntry>? Entries
        {
            get => (IReadOnlyList<MuiBubbleMenuEntry>?)GetValue(EntriesProperty);
            set => SetValue(EntriesProperty, value);
        }

        public event EventHandler<string>? ItemSelected;
        public event EventHandler? CloseRequested;

        private readonly MuiPopover _popover = new() { Placement = MuiPopoverPlacement.Top };
        private readonly StackPanel _row = new() { Orientation = Orientation.Horizontal, Spacing = 2 };

        public MuiBubbleMenu()
        {
            Content = _popover;
            IsTabStop = false;
            IsHitTestVisible = false;

            _popover.PanelContent = _row;
            _popover.CloseRequested += (_, _) => CloseRequested?.Invoke(this, EventArgs.Empty);

            Rebuild();
        }

        private void Rebuild()
        {
            _row.Children.Clear();
            foreach (var entry in Entries ?? Array.Empty<MuiBubbleMenuEntry>())
            {
                if (entry.IsDivider)
                {
                    _row.Children.Add(new MuiDivider { Orientation = MuiDividerOrientation.Vertical, Margin = new Thickness(2, 0, 2, 0) });
                    continue;
                }

                var item = entry.Item!;
                var button = new MuiActionButton
                {
                    IconName = item.IconName,
                    Selected = item.Active,
                    ButtonSize = MuiActionButtonSize.Sm,
                };
                AutomationProperties.SetName(button, item.Label);
                button.Click += (_, _) => ItemSelected?.Invoke(this, item.Id);
                _row.Children.Add(button);
            }
        }
    }
}
