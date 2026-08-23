using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>Resolution of a proposed change (unified-component-
    /// catalog.md §3, "Suggestion Preview" row).</summary>
    public enum MuiSuggestionResolution { Accepted, Rejected }

    /// <summary>
    /// Maple.UI Suggestion Preview molecule (unified-component-catalog.md
    /// §3, "Suggestion Preview" row: "Proposed change with accept/reject",
    /// built from Text, Button) — a description with Accept/Reject
    /// icon-only actions, replaced by a colored resolution label once
    /// <see cref="Resolved"/> is set (null = still pending, matching
    /// `mui-suggestion-preview.component.ts`'s own nullable
    /// <c>resolved()</c>).
    /// </summary>
    public sealed class MuiSuggestionPreview : ContentControl
    {
        public static readonly DependencyProperty DescriptionProperty =
            DependencyProperty.Register(nameof(Description), typeof(string), typeof(MuiSuggestionPreview),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiSuggestionPreview)d).Rebuild()));

        public static readonly DependencyProperty ResolvedProperty =
            DependencyProperty.Register(nameof(Resolved), typeof(MuiSuggestionResolution?), typeof(MuiSuggestionPreview),
                new PropertyMetadata(null, (d, _) => ((MuiSuggestionPreview)d).Rebuild()));

        public string Description
        {
            get => (string)GetValue(DescriptionProperty);
            set => SetValue(DescriptionProperty, value);
        }

        public MuiSuggestionResolution? Resolved
        {
            get => (MuiSuggestionResolution?)GetValue(ResolvedProperty);
            set => SetValue(ResolvedProperty, value);
        }

        public event EventHandler? Accepted;
        public event EventHandler? Rejected;

        private readonly StackPanel _root = new() { Orientation = Orientation.Horizontal, Spacing = 10 };
        private readonly MuiText _descriptionText = new() { Variant = MuiTextVariant.Body, Truncate = true };
        private readonly StackPanel _actions = new() { Orientation = Orientation.Horizontal, Spacing = 4 };
        private readonly MuiButton _acceptButton = new() { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm, IconName = "check" };
        private readonly MuiButton _rejectButton = new() { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm, IconName = "x" };
        private readonly MuiText _resolvedText = new() { Variant = MuiTextVariant.ChipLabel };

        public MuiSuggestionPreview()
        {
            _actions.Children.Add(_acceptButton);
            _actions.Children.Add(_rejectButton);
            _root.Children.Add(_descriptionText);
            _root.Children.Add(_actions);
            _root.Children.Add(_resolvedText);
            Content = _root;
            IsTabStop = false;

            _acceptButton.Click += (_, _) => Accepted?.Invoke(this, EventArgs.Empty);
            _rejectButton.Click += (_, _) => Rejected?.Invoke(this, EventArgs.Empty);
            AutomationProperties.SetName(_acceptButton, "Accept");
            AutomationProperties.SetName(_rejectButton, "Reject");

            Rebuild();
        }

        private void Rebuild()
        {
            _descriptionText.Text = Description;

            var pending = Resolved is null;
            _actions.Visibility = pending ? Visibility.Visible : Visibility.Collapsed;
            _resolvedText.Visibility = pending ? Visibility.Collapsed : Visibility.Visible;

            if (Resolved is { } resolution)
            {
                _resolvedText.Text = resolution == MuiSuggestionResolution.Accepted ? "Accepted" : "Rejected";
                _resolvedText.ColorRole = resolution == MuiSuggestionResolution.Accepted ? MuiTextColorRole.Success : MuiTextColorRole.Error;
            }
        }
    }
}
