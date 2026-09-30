using System;
using System.Linq;
using Maple.UI.Atoms;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;

namespace Maple.WinUI.Services.Transfer;

/// <summary>Current and incoming values in the production selective-paste modal.</summary>
public sealed class TransferPreviewFields
{
    public StackPanel Root { get; } = new() { Spacing = 12 };
    public MuiCheckbox Relative { get; } = new() { Label = "Relative white balance — use each photo's camera baseline", IsThreeState = false };
    public TextBlock Status { get; } = Text("");
    private readonly StackPanel _values = new() { Spacing = 10 };
    public TransferPreviewFields()
    {
        Root.Children.Add(Relative);
        Root.Children.Add(Text("Only checked groups change. Masks, repairs and source sampling coordinates are excluded. Copying white balance clears sampling provenance."));
        AutomationProperties.SetLiveSetting(Status, AutomationLiveSetting.Polite);
        Root.Children.Add(Status);
        Root.Children.Add(_values);
    }

    public void Show(TransferPreviewResult preview)
    {
        _values.Children.Clear();
        foreach (var group in preview.Groups)
        {
            var section = new StackPanel { Spacing = 6 };
            foreach (var field in group.Fields)
                section.Children.Add(Text($"{Label(field.Name)}\nCurrent: {field.Current}\nIncoming: {field.Incoming}\nChanges {field.ChangedPhotos} of {field.TotalPhotos} photos"));
            var expander = new Expander { Header = group.Label, Content = section, HorizontalAlignment = HorizontalAlignment.Stretch,
                HorizontalContentAlignment = HorizontalAlignment.Stretch };
            AutomationProperties.SetName(expander, group.Label + " current and incoming values");
            _values.Children.Add(expander);
        }
    }

    private static TextBlock Text(string value) => new() { Text = value, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
    private static string Label(string name) => string.Join(" ", name.Split('_').Select(s => s.Length == 0 ? s : char.ToUpperInvariant(s[0]) + s.Substring(1)));
}
