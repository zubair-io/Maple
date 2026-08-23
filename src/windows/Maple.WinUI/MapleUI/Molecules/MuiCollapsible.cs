using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Collapsible molecule (unified-component-catalog.md §2.5,
    /// "Collapsible" row: "Disclosure header + animated content region",
    /// built from Icon, Text) — a header row (chevron + label) that toggles
    /// a content region on click/Enter/Space.
    ///
    /// The header is a plain ghost-styled <see cref="Button"/> rather than a
    /// hand-rolled hit target — same reasoning MuiButton's own doc comment
    /// gives — so keyboard activation comes from the platform for free. The
    /// content region's "animated" requirement is satisfied with a simple
    /// Visibility + Opacity fade-in <see cref="Storyboard"/> on open (per
    /// this wave's brief: "height animation via simple visibility + opacity
    /// storyboard is acceptable") rather than an actual height animation —
    /// no local compiler to verify a Grid-row-height animation against.
    /// </summary>
    public sealed class MuiCollapsible : ContentControl
    {
        public static readonly DependencyProperty LabelProperty =
            DependencyProperty.Register(nameof(Label), typeof(string), typeof(MuiCollapsible),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiCollapsible)d).Rebuild()));

        public static readonly DependencyProperty IsExpandedProperty =
            DependencyProperty.Register(nameof(IsExpanded), typeof(bool), typeof(MuiCollapsible),
                new PropertyMetadata(false, (d, e) => ((MuiCollapsible)d).OnIsExpandedChanged((bool)e.NewValue)));

        public static readonly DependencyProperty BodyContentProperty =
            DependencyProperty.Register(nameof(BodyContent), typeof(object), typeof(MuiCollapsible),
                new PropertyMetadata(null, (d, e) => ((MuiCollapsible)d)._bodyHost.Content = e.NewValue));

        public string Label
        {
            get => (string)GetValue(LabelProperty);
            set => SetValue(LabelProperty, value);
        }

        public bool IsExpanded
        {
            get => (bool)GetValue(IsExpandedProperty);
            set => SetValue(IsExpandedProperty, value);
        }

        /// <summary>The disclosed body — shown/hidden by
        /// <see cref="IsExpanded"/>.</summary>
        public object? BodyContent
        {
            get => GetValue(BodyContentProperty);
            set => SetValue(BodyContentProperty, value);
        }

        /// <summary>Fires after a click/keyboard toggle with the new
        /// expanded state.</summary>
        public event EventHandler<bool>? ExpandedChanged;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 0 };
        private readonly Button _headerButton = new()
        {
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            BorderThickness = new Thickness(0),
            Padding = new Thickness(4, 6, 4, 6),
            HorizontalAlignment = HorizontalAlignment.Stretch,
            HorizontalContentAlignment = HorizontalAlignment.Left,
        };
        private readonly StackPanel _headerContent = new() { Orientation = Orientation.Horizontal, Spacing = 8 };
        private readonly MuiIcon _chevron = new() { Size = MuiIconSize.Sm16 };
        private readonly MuiText _labelText = new() { Variant = MuiTextVariant.RowLabel };
        private readonly ContentControl _bodyHost = new() { IsTabStop = false, Padding = new Thickness(4, 8, 4, 4) };

        public MuiCollapsible()
        {
            _headerContent.Children.Add(_chevron);
            _headerContent.Children.Add(_labelText);
            _headerButton.Content = _headerContent;
            _headerButton.Click += (_, _) => Toggle();

            _root.Children.Add(_headerButton);
            _root.Children.Add(_bodyHost);
            Content = _root;
            IsTabStop = false;

            Rebuild();
        }

        private void Toggle() => IsExpanded = !IsExpanded;

        /// <summary>Fires only from an actual <see cref="IsExpanded"/>
        /// transition (WinUI's DependencyProperty system already skips this
        /// callback for a same-value set) — kept separate from
        /// <see cref="Rebuild"/> so a Label/BodyContent update alone never
        /// spuriously raises <see cref="ExpandedChanged"/>.</summary>
        private void OnIsExpandedChanged(bool expanded)
        {
            Rebuild();
            ExpandedChanged?.Invoke(this, expanded);
        }

        private void Rebuild()
        {
            _labelText.Text = Label;
            _chevron.IconName = IsExpanded ? "chevron-down" : "chevron-right";

            if (IsExpanded)
            {
                _bodyHost.Visibility = Visibility.Visible;
                AnimateOpen();
            }
            else
            {
                _bodyHost.Visibility = Visibility.Collapsed;
                _bodyHost.Opacity = 1; // reset so the next open's fade-in starts clean
            }

            if (!string.IsNullOrEmpty(Label))
                AutomationProperties.SetName(_headerButton, Label);
        }

        private void AnimateOpen()
        {
            _bodyHost.Opacity = 0;
            var anim = new DoubleAnimation
            {
                From = 0,
                To = 1,
                Duration = new Duration(TimeSpan.FromMilliseconds(150)),
            };
            Storyboard.SetTarget(anim, _bodyHost);
            Storyboard.SetTargetProperty(anim, "Opacity");
            var storyboard = new Storyboard();
            storyboard.Children.Add(anim);
            storyboard.Begin();
        }
    }
}
