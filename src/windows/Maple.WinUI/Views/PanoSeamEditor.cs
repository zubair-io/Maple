using System;
using System.Collections.Generic;
using System.Linq;
using Maple.UI.Atoms;
using Maple.WinUI.Services.Pano;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Windows.System;

namespace Maple.WinUI.Views;

/// <summary>The stitch dialog's seam-region controls (#5992): the ordered
/// source frame and Include/Exclude pickers, the coordinate fields that do
/// everything dragging on the preview does, and the numbered region list.
/// Editing never starts work; "Preview regions" asks for a constrained
/// preview. UI-thread only.</summary>
internal sealed class PanoSeamEditor
{
    private readonly PanoSeamAuthoring _authoring;
    private readonly MuiText _guide = new() { Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted };
    private readonly TextBlock _reason = Status("MapleWarn", AutomationLiveSetting.Polite);
    private readonly ComboBox _frame = Picker("Source frame", "Seam source frame");
    private readonly ComboBox _kind = Picker("Region mode", "Seam region mode");
    private readonly TextBox _x = Field("X", "0");
    private readonly TextBox _y = Field("Y", "0");
    private readonly TextBox _width = Field("Width", "1");
    private readonly TextBox _height = Field("Height", "1");
    private readonly TextBlock _message = Status("MapleErrorText", AutomationLiveSetting.Assertive);
    private readonly MuiButton _add = Command("Add region", MuiButtonVariant.Secondary, "Add seam region from numeric coordinates");
    private readonly MuiButton _clear = Command("Clear regions", MuiButtonVariant.Ghost, "Clear all seam regions");
    private readonly MuiButton _preview = Command("Preview regions", MuiButtonVariant.Secondary, "Preview panorama with seam regions");
    private readonly MuiText _count = new() { Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted };
    private readonly StackPanel _list = new() { Spacing = 4 };

    public PanoSeamEditor(PanoSeamAuthoring authoring)
    {
        _authoring = authoring;
        Overlay = new PanoSeamOverlay(authoring);
        _kind.Items.Add(PanoSeamText.Include);
        _kind.Items.Add(PanoSeamText.Exclude);
        _kind.SelectedIndex = 0;

        var fields = new Grid { ColumnSpacing = 8 };
        foreach (var (field, column) in Fields.Select((field, column) => (field, column)))
        {
            fields.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            Grid.SetColumn(field, column);
            fields.Children.Add(field);
            field.KeyDown += OnFieldKeyDown;
        }
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
        actions.Children.Add(_add);
        actions.Children.Add(_clear);
        actions.Children.Add(_preview);

        _add.Click += (_, _) => AddFromFields();
        _clear.Click += (_, _) =>
        {
            _authoring.Clear();
            ShowMessage(null);
        };
        _preview.Click += (_, _) =>
        {
            ShowMessage(null);
            PreviewRequested?.Invoke();
        };
        Overlay.Drawn += rect => ShowMessage(_authoring.Add(SelectedKind, _frame.SelectedIndex, rect));

        Root.Children.Add(new MuiText { Text = "Seam regions", Variant = MuiTextVariant.RowLabel });
        foreach (var element in new UIElement[] { _guide, _reason, _frame, _kind, fields, _message, actions, _count, _list })
            Root.Children.Add(element);
        authoring.Changed += Refresh;
        Refresh();
    }

    public event Action? PreviewRequested;

    public StackPanel Root { get; } = new() { Spacing = 8 };

    public PanoSeamOverlay Overlay { get; }

    private IReadOnlyList<TextBox> Fields => new[] { _x, _y, _width, _height };

    private PanoSeamKind SelectedKind => _kind.SelectedIndex == 1 ? PanoSeamKind.Exclude : PanoSeamKind.Include;

    /// <summary>The error or named refusal beside the regions; null clears it.</summary>
    public void ShowMessage(string? message) => SetStatus(_message, message);

    /// <summary>Whether keyboard focus is in a coordinate field, where
    /// Enter adds the region rather than starting the stitch.</summary>
    public bool OwnsFocus(XamlRoot? root) =>
        root is not null && FocusManager.GetFocusedElement(root) is TextBox focused && Fields.Contains(focused);

    internal void AddFromFields() =>
        ShowMessage(_authoring.AddFromText(
            SelectedKind, _frame.SelectedIndex, _x.Text, _y.Text, _width.Text, _height.Text));

    private void OnFieldKeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter)
            return;
        e.Handled = true;
        AddFromFields();
    }

    private void Refresh()
    {
        var reason = _authoring.DisabledReason;
        ListFrames();
        _guide.Text = PanoSeamText.Guide(_authoring.Canvas);
        SetStatus(_reason, reason);
        foreach (var control in new Control[] { _frame, _kind, _x, _y, _width, _height, _add, _preview })
            control.IsEnabled = reason is null;
        _clear.IsEnabled = _authoring.Regions.Count > 0;
        _count.Text = PanoSeamText.Count(_authoring.Regions.Count);
        _list.Children.Clear();
        foreach (var (region, index) in _authoring.Regions.Select((region, index) => (region, index)))
            _list.Children.Add(Row(region, index));
    }

    private void ListFrames()
    {
        var labels = PanoSeamText.FrameLabels(_authoring.Frames);
        if (_frame.Items.Cast<string>().SequenceEqual(labels))
            return;
        _frame.Items.Clear();
        foreach (var label in labels)
            _frame.Items.Add(label);
        _frame.SelectedIndex = labels.Count > 0 ? 0 : -1;
    }

    private Grid Row(PanoSeamRegion region, int index)
    {
        var remove = new MuiButton { Label = "Remove", Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm };
        AutomationProperties.SetName(remove, PanoSeamText.Remove(index));
        remove.Click += (_, _) =>
        {
            _authoring.Remove(index);
            ShowMessage(null);
            FocusAfterRemoving(index);
        };
        var row = new Grid { ColumnSpacing = 8 };
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        Grid.SetColumn(remove, 1);
        row.Children.Add(new MuiText
        {
            Text = PanoSeamText.Region(index, region),
            Variant = MuiTextVariant.Body,
            VerticalAlignment = VerticalAlignment.Center,
        });
        row.Children.Add(remove);
        return row;
    }

    // The pressed button is gone once its region is; keep keyboard focus on
    // the row that took its place, or on Add when the list is empty.
    private void FocusAfterRemoving(int index)
    {
        var rows = _list.Children.OfType<Grid>().ToList();
        var next = rows.Count == 0
            ? _add
            : rows[Math.Min(index, rows.Count - 1)].Children.OfType<MuiButton>().First();
        next.Focus(FocusState.Programmatic);
    }

    private static void SetStatus(TextBlock block, string? text)
    {
        var shown = text ?? string.Empty;
        if (block.Text == shown)
            return;
        block.Text = shown;
        block.Visibility = shown.Length > 0 ? Visibility.Visible : Visibility.Collapsed;
        if (shown.Length > 0)
            FrameworkElementAutomationPeer.FromElement(block)?.RaiseAutomationEvent(AutomationEvents.LiveRegionChanged);
    }

    private static TextBlock Status(string brush, AutomationLiveSetting live)
    {
        var block = new TextBlock
        {
            TextWrapping = TextWrapping.Wrap,
            Visibility = Visibility.Collapsed,
            Foreground = (Brush)Application.Current.Resources[brush],
        };
        AutomationProperties.SetLiveSetting(block, live);
        return block;
    }

    private static ComboBox Picker(string header, string name)
    {
        var picker = new ComboBox { Header = header, HorizontalAlignment = HorizontalAlignment.Stretch };
        AutomationProperties.SetName(picker, name);
        return picker;
    }

    private static TextBox Field(string header, string value)
    {
        var field = new TextBox { Header = header, Text = value };
        AutomationProperties.SetName(field, $"Seam region {header}");
        return field;
    }

    private static MuiButton Command(string label, MuiButtonVariant variant, string name)
    {
        var button = new MuiButton { Label = label, Variant = variant };
        AutomationProperties.SetName(button, name);
        return button;
    }
}
