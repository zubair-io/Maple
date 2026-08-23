using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Enrichment Panel organism (unified-component-catalog.md
    /// §4.3, "Enrichment Panel" row: "AI-derived fields with live
    /// status", built from Description Field, Faces Row, Place Row,
    /// Transcript Block, Vision Row, Badge) — every AI-derived field for
    /// one asset, each carrying its own regenerate/redetect affordance
    /// and a status <see cref="MuiBadge"/> (e.g. "queued", "model:
    /// qwen2.5-vl") next to the section label.
    /// </summary>
    public sealed class MuiEnrichmentPanel : ContentControl
    {
        public static readonly DependencyProperty DescriptionProperty =
            DependencyProperty.Register(nameof(Description), typeof(string), typeof(MuiEnrichmentPanel),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiEnrichmentPanel)d)._description.Value = (string)e.NewValue));

        public static readonly DependencyProperty DescriptionRegeneratingProperty =
            DependencyProperty.Register(nameof(DescriptionRegenerating), typeof(bool), typeof(MuiEnrichmentPanel),
                new PropertyMetadata(false, (d, e) => ((MuiEnrichmentPanel)d)._description.Regenerating = (bool)e.NewValue));

        public static readonly DependencyProperty PeopleProperty =
            DependencyProperty.Register(nameof(People), typeof(IReadOnlyList<MuiChip>), typeof(MuiEnrichmentPanel),
                new PropertyMetadata(null, (d, e) => ((MuiEnrichmentPanel)d)._faces.People = (IReadOnlyList<MuiChip>?)e.NewValue));

        public static readonly DependencyProperty PlaceProperty =
            DependencyProperty.Register(nameof(Place), typeof(string), typeof(MuiEnrichmentPanel),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiEnrichmentPanel)d)._place.Place = (string)e.NewValue));

        public static readonly DependencyProperty TranscriptEntriesProperty =
            DependencyProperty.Register(nameof(TranscriptEntries), typeof(IReadOnlyList<MuiTranscriptEntry>), typeof(MuiEnrichmentPanel),
                new PropertyMetadata(null, (d, e) => ((MuiEnrichmentPanel)d)._transcript.Entries = (IReadOnlyList<MuiTranscriptEntry>?)e.NewValue));

        public static readonly DependencyProperty VisionLabelsProperty =
            DependencyProperty.Register(nameof(VisionLabels), typeof(IReadOnlyList<MuiChip>), typeof(MuiEnrichmentPanel),
                new PropertyMetadata(null, (d, e) => ((MuiEnrichmentPanel)d)._vision.Labels = (IReadOnlyList<MuiChip>?)e.NewValue));

        public static readonly DependencyProperty StatusLabelProperty =
            DependencyProperty.Register(nameof(StatusLabel), typeof(string), typeof(MuiEnrichmentPanel),
                new PropertyMetadata(null, (d, _) => ((MuiEnrichmentPanel)d).Rebuild()));

        public string Description { get => (string)GetValue(DescriptionProperty); set => SetValue(DescriptionProperty, value); }
        public bool DescriptionRegenerating { get => (bool)GetValue(DescriptionRegeneratingProperty); set => SetValue(DescriptionRegeneratingProperty, value); }
        public IReadOnlyList<MuiChip>? People { get => (IReadOnlyList<MuiChip>?)GetValue(PeopleProperty); set => SetValue(PeopleProperty, value); }
        public string Place { get => (string)GetValue(PlaceProperty); set => SetValue(PlaceProperty, value); }
        public IReadOnlyList<MuiTranscriptEntry>? TranscriptEntries { get => (IReadOnlyList<MuiTranscriptEntry>?)GetValue(TranscriptEntriesProperty); set => SetValue(TranscriptEntriesProperty, value); }
        public IReadOnlyList<MuiChip>? VisionLabels { get => (IReadOnlyList<MuiChip>?)GetValue(VisionLabelsProperty); set => SetValue(VisionLabelsProperty, value); }
        public string? StatusLabel { get => (string?)GetValue(StatusLabelProperty); set => SetValue(StatusLabelProperty, value); }

        public event EventHandler? DescriptionRegenerateRequested;
        public event EventHandler<string>? DescriptionCommitted;
        public event EventHandler? FacesRedetectRequested;
        public event EventHandler<string>? PlaceCommitted;
        public event EventHandler? PlaceCleared;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 20 };
        private readonly MuiBadge _statusBadge = new() { Variant = MuiBadgeVariant.Signal };
        private readonly MuiDescriptionField _description = new() { Placeholder = "No description yet" };
        private readonly MuiFacesRow _faces = new();
        private readonly MuiPlaceRow _place = new();
        private readonly MuiTranscriptBlock _transcript = new();
        private readonly MuiVisionRow _vision = new();

        public MuiEnrichmentPanel()
        {
            _root.Children.Add(Section("Description", _description));
            _root.Children.Add(Section("People", _faces));
            _root.Children.Add(Section("Place", _place));
            _root.Children.Add(Section("Transcript", _transcript));
            _root.Children.Add(Section("Vision labels", _vision));
            Content = _root;

            _description.Regenerate += (_, _) => DescriptionRegenerateRequested?.Invoke(this, EventArgs.Empty);
            _description.Committed += (_, text) => { Description = text; DescriptionCommitted?.Invoke(this, text); };
            _faces.Redetect += (_, _) => FacesRedetectRequested?.Invoke(this, EventArgs.Empty);
            _place.Committed += (_, text) => { Place = text; PlaceCommitted?.Invoke(this, text); };
            _place.Cleared += (_, _) => PlaceCleared?.Invoke(this, EventArgs.Empty);

            Rebuild();
        }

        private UIElement Section(string label, UIElement body)
        {
            var stack = new StackPanel { Orientation = Orientation.Vertical, Spacing = 8 };
            var heading = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            heading.Children.Add(new MuiText { Text = label, Variant = MuiTextVariant.Eyebrow, ColorRole = MuiTextColorRole.Muted });
            if (label == "Description") heading.Children.Add(_statusBadge);
            stack.Children.Add(heading);
            stack.Children.Add(body);
            return stack;
        }

        private void Rebuild()
        {
            _statusBadge.Visibility = string.IsNullOrEmpty(StatusLabel) ? Visibility.Collapsed : Visibility.Visible;
            _statusBadge.Value = StatusLabel ?? string.Empty;
        }
    }
}
