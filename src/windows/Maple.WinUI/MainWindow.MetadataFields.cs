using System;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;
using Maple.WinUI.Generated;
using Maple.WinUI.Services.Metadata;

namespace Maple.WinUI;

public sealed partial class MainWindow
{
    private sealed class MetadataFields
    {
        public StackPanel Root { get; } = new() { Spacing = 12 };
        public StackPanel Inputs { get; } = new() { Spacing = 10 };
        public MuiText Status { get; } = new() { Variant = MuiTextVariant.Body };
        public ListView Preview { get; } = new() { MaxHeight = 160, SelectionMode = ListViewSelectionMode.None };
        private readonly ComboBox _rating = Choice("Rating", "Keep unchanged", "Clear rating", "1 star", "2 stars", "3 stars", "4 stars", "5 stars");
        private readonly ComboBox _flag = Choice("Flag", "Keep unchanged", "Clear flag", "Pick", "Reject");
        private readonly ComboBox _label = Choice("Color label", new[] { "Keep unchanged", "Clear label" }.Concat(ColorLabelVocabulary.Values).ToArray());
        private readonly ComboBox _operation = Choice("Keywords", "Keep unchanged", "Add", "Remove", "Replace all (empty clears)");
        private readonly TextBox _keywords = new() { Header = "Keywords, one per line", AcceptsReturn = true, Height = 80, IsEnabled = false };
        private readonly MuiText _current = new() { Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted };
        public event Action? Changed;

        public void SetEnabled(bool enabled)
        {
            foreach (var box in new[] { _rating, _flag, _label, _operation }) box.IsEnabled = enabled;
            _keywords.IsEnabled = enabled && _operation.SelectedIndex != 0;
        }

        public MetadataFields()
        {
            Root.Children.Add(_current);
            var choices = new Grid { ColumnSpacing = 12, RowSpacing = 10 };
            choices.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
            choices.ColumnDefinitions.Add(new() { Width = new GridLength(1, GridUnitType.Star) });
            choices.RowDefinitions.Add(new());
            choices.RowDefinitions.Add(new());
            var controls = new[] { _rating, _flag, _label, _operation };
            for (var i = 0; i < controls.Length; i++)
            {
                Grid.SetRow(controls[i], i / 2);
                Grid.SetColumn(controls[i], i % 2);
                choices.Children.Add(controls[i]);
                controls[i].SelectionChanged += (_, _) =>
                {
                    _keywords.IsEnabled = _operation.SelectedIndex != 0;
                    Changed?.Invoke();
                };
            }
            _keywords.TextChanged += (_, _) => Changed?.Invoke();
            Inputs.Children.Add(choices);
            Inputs.Children.Add(_keywords);
            Root.Children.Add(Inputs);
            Root.Children.Add(Status);
            Root.Children.Add(Preview);
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(Preview, "Metadata change preview and per-photo results");
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(_keywords, "Keywords, one per line");
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetLiveSetting(Status, Microsoft.UI.Xaml.Automation.Peers.AutomationLiveSetting.Polite);
        }

        public MetadataPatch Patch() => new(
            Rating: _rating.SelectedIndex == 0 ? null : _rating.SelectedIndex - 1,
            Flag: _flag.SelectedIndex switch { 1 => "none", 2 => "pick", 3 => "reject", _ => null },
            SetLabel: _label.SelectedIndex > 0,
            Label: _label.SelectedIndex < 2 ? null : ColorLabelVocabulary.Values[_label.SelectedIndex - 2],
            KeywordOperation: (KeywordOperation)_operation.SelectedIndex,
            Keywords: _keywords.Text.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries));

        public void ShowCurrent(MetadataBatchItem[] items)
        {
            string Mixed(Func<MetadataValues, string> value)
            {
                var values = items.Select(i => value(i.Before)).Distinct().Take(2).ToArray();
                return values.Length == 1 ? values[0] : "Mixed";
            }
            _current.Text = $"Current: rating {Mixed(v => v.Rating == 0 ? "none" : v.Rating.ToString())}; " +
                $"flag {Mixed(v => v.Flag)}; label {Mixed(v => v.Label ?? "none")}; " +
                $"keywords {Mixed(v => v.Keywords.Length == 0 ? "none" : string.Join(", ", v.Keywords.OrderBy(k => k, StringComparer.Ordinal)))}.\n" +
                "Only fields you change will be applied to the captured selection.";
        }

        public void ShowPreview(MetadataBatch batch, bool results)
        {
            Preview.ItemsSource = batch.Items.Select(item =>
            {
                var values = item.Saved ?? batch.Project(item.Before);
                var state = results ? item.Saved != null ? "Saved" : item.Error != null ? "Failed: " + item.Error : "Pending" : "Preview";
                return $"{item.Target.Name} — {state}\n" +
                    $"Rating {values.Rating}; flag {values.Flag}; label {values.Label ?? "none"}; " +
                    $"keywords: {(values.Keywords.Length == 0 ? "none" : string.Join(", ", values.Keywords))}";
            }).ToArray();
        }

        private static ComboBox Choice(string header, params string[] values)
        {
            var box = new ComboBox { Header = header, HorizontalAlignment = HorizontalAlignment.Stretch };
            foreach (var value in values) box.Items.Add(value);
            box.SelectedIndex = 0;
            Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(box, header);
            return box;
        }
    }
}
