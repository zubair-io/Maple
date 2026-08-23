using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One request the Endpoint Form can send.</summary>
    public readonly record struct MuiEndpointRequest(string Method, string Url);

    /// <summary>
    /// Maple.UI Endpoint Form molecule (unified-component-catalog.md §3,
    /// "Endpoint Form" row: "Interactive request builder", built from Form
    /// Field, Button, Badge) — an HTTP-method radio-like row (each option a
    /// <see cref="MuiBadge"/>, Signal variant while selected), a URL
    /// <see cref="MuiFormField"/>, and a Send action.
    /// </summary>
    public sealed class MuiEndpointForm : ContentControl
    {
        private static readonly IReadOnlyList<string> DefaultMethods = new[] { "GET", "POST", "PUT", "DELETE" };

        public static readonly DependencyProperty MethodsProperty =
            DependencyProperty.Register(nameof(Methods), typeof(IReadOnlyList<string>), typeof(MuiEndpointForm),
                new PropertyMetadata(DefaultMethods, (d, _) => ((MuiEndpointForm)d).RebuildMethods()));

        public static readonly DependencyProperty MethodProperty =
            DependencyProperty.Register(nameof(Method), typeof(string), typeof(MuiEndpointForm),
                new PropertyMetadata("GET", (d, _) => ((MuiEndpointForm)d).RebuildMethods()));

        public static readonly DependencyProperty UrlProperty =
            DependencyProperty.Register(nameof(Url), typeof(string), typeof(MuiEndpointForm),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiEndpointForm)d)._urlInput.Text = (string)e.NewValue));

        public static readonly DependencyProperty SendingProperty =
            DependencyProperty.Register(nameof(Sending), typeof(bool), typeof(MuiEndpointForm),
                new PropertyMetadata(false, (d, e) => ((MuiEndpointForm)d)._sendButton.IsLoading = (bool)e.NewValue));

        public IReadOnlyList<string> Methods
        {
            get => (IReadOnlyList<string>)GetValue(MethodsProperty);
            set => SetValue(MethodsProperty, value);
        }

        public string Method
        {
            get => (string)GetValue(MethodProperty);
            set => SetValue(MethodProperty, value);
        }

        public string Url
        {
            get => (string)GetValue(UrlProperty);
            set => SetValue(UrlProperty, value);
        }

        public bool Sending
        {
            get => (bool)GetValue(SendingProperty);
            set => SetValue(SendingProperty, value);
        }

        public event EventHandler<MuiEndpointRequest>? Send;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 10 };
        private readonly StackPanel _methodRow = new() { Orientation = Orientation.Horizontal, Spacing = 6 };
        private readonly MuiInput _urlInput = new() { Placeholder = "/api/photos" };
        private readonly MuiFormField _urlField = new() { Label = "URL" };
        private readonly MuiButton _sendButton = new() { Variant = MuiButtonVariant.Primary, Label = "Send" };

        public MuiEndpointForm()
        {
            _urlField.ControlContent = _urlInput;
            _root.Children.Add(_methodRow);
            _root.Children.Add(_urlField);
            _root.Children.Add(_sendButton);
            Content = _root;
            IsTabStop = false;

            _urlInput.Committed += (_, text) => Url = text;
            _sendButton.Click += (_, _) => Send?.Invoke(this, new MuiEndpointRequest(Method, Url));

            RebuildMethods();
        }

        private void RebuildMethods()
        {
            _methodRow.Children.Clear();
            foreach (var method in Methods ?? DefaultMethods)
            {
                var button = new Button
                {
                    Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
                    BorderThickness = new Thickness(0),
                    Padding = new Thickness(0),
                    Content = new MuiBadge { Variant = method == Method ? MuiBadgeVariant.Signal : MuiBadgeVariant.Count, Value = method },
                };
                var selected = method;
                button.Click += (_, _) => Method = selected;
                _methodRow.Children.Add(button);
            }
        }
    }
}
