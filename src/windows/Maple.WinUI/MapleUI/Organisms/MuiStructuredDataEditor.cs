using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>Which view a Structured Data Editor is showing.</summary>
    public enum MuiStructuredDataView { Code, Form }

    /// <summary>
    /// Maple.UI Structured Data Editor organism (unified-component-catalog.md
    /// §4.5, "Structured Data Editor" row: "JSON as code or as a form",
    /// built from Code Block, Form Field, Tabs) — a
    /// <see cref="MuiTabs"/> switches between a raw-text
    /// <see cref="MuiInput"/> (a live-editable stand-in for
    /// <see cref="MuiCodeBlock"/>, which has no editable surface of its
    /// own) and a generated stack of <see cref="MuiFormField"/>s, one per
    /// flat property. Both views share the same
    /// <see cref="MuiStructuredDataEditorLogic"/> parse/serialize round
    /// trip; an invalid code edit surfaces its error inline rather than
    /// losing the form view's last-good state.
    /// </summary>
    public sealed class MuiStructuredDataEditor : ContentControl
    {
        public static readonly DependencyProperty JsonProperty =
            DependencyProperty.Register(nameof(Json), typeof(string), typeof(MuiStructuredDataEditor),
                new PropertyMetadata("{}", (d, _) => ((MuiStructuredDataEditor)d).Rebuild()));

        public static readonly DependencyProperty ViewProperty =
            DependencyProperty.Register(nameof(View), typeof(MuiStructuredDataView), typeof(MuiStructuredDataEditor),
                new PropertyMetadata(MuiStructuredDataView.Form, (d, _) => ((MuiStructuredDataEditor)d).Rebuild()));

        public string Json { get => (string)GetValue(JsonProperty); set => SetValue(JsonProperty, value); }
        public MuiStructuredDataView View { get => (MuiStructuredDataView)GetValue(ViewProperty); set => SetValue(ViewProperty, value); }

        public event EventHandler<string>? JsonChanged;

        private static readonly MuiTab[] ViewTabs = { new("form", "Form"), new("code", "Code") };

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 12 };
        private readonly MuiTabs _tabs = new() { Tabs = ViewTabs };
        private readonly MuiBanner _errorBanner = new() { Variant = MuiBannerVariant.Error, Visibility = Visibility.Collapsed };
        private readonly MuiInput _codeInput = new() { Placeholder = "{}" };
        private readonly StackPanel _formFields = new() { Orientation = Orientation.Vertical, Spacing = 10 };

        public MuiStructuredDataEditor()
        {
            _root.Children.Add(_tabs);
            _root.Children.Add(_errorBanner);
            _root.Children.Add(_codeInput);
            _root.Children.Add(_formFields);
            Content = _root;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;

            _tabs.SelectionChanged += (_, id) => View = id == "code" ? MuiStructuredDataView.Code : MuiStructuredDataView.Form;
            _codeInput.Committed += (_, text) =>
            {
                var fields = MuiStructuredDataEditorLogic.ParseFlatJson(text, out var error);
                if (error is not null) { _errorBanner.Message = error; _errorBanner.Visibility = Visibility.Visible; return; }
                _errorBanner.Visibility = Visibility.Collapsed;
                Json = MuiStructuredDataEditorLogic.ToJson(fields);
                JsonChanged?.Invoke(this, Json);
            };

            Rebuild();
        }

        private void Rebuild()
        {
            _tabs.ActiveId = View == MuiStructuredDataView.Code ? "code" : "form";
            _codeInput.Visibility = View == MuiStructuredDataView.Code ? Visibility.Visible : Visibility.Collapsed;
            _formFields.Visibility = View == MuiStructuredDataView.Form ? Visibility.Visible : Visibility.Collapsed;

            var fields = MuiStructuredDataEditorLogic.ParseFlatJson(Json, out var error);
            _codeInput.Text = Json;
            _errorBanner.Visibility = Visibility.Collapsed;

            _formFields.Children.Clear();
            if (error is not null) return;
            foreach (var field in fields)
            {
                var valueInput = new MuiInput { Text = field.Value };
                var key = field.Key;
                valueInput.Committed += (_, value) => CommitField(fields, key, value);
                _formFields.Children.Add(new MuiFormField { Label = field.Key, ControlContent = valueInput });
            }
        }

        private void CommitField(IReadOnlyList<MuiStructuredField> current, string key, string value)
        {
            var updated = current.Select(f => f.Key == key ? f with { Value = value } : f).ToList();
            Json = MuiStructuredDataEditorLogic.ToJson(updated);
            JsonChanged?.Invoke(this, Json);
        }
    }
}
