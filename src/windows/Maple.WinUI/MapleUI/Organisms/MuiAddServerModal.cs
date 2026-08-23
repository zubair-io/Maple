using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>The server address + credentials an Add Server modal collects.</summary>
    public sealed record MuiServerConnection(string Address, string Username, string Password);

    /// <summary>
    /// Maple.UI Add Server modal organism (unified-component-catalog.md
    /// §4.4, "Add Server" row: "Sign-in and registration", built from
    /// Form Field, Button, Banner) — address/username/password
    /// <see cref="MuiFormField"/>s, a Connect action, and a
    /// <see cref="MuiBanner"/> for a failed-connection error.
    /// </summary>
    public sealed class MuiAddServerModal : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiAddServerModal),
                new PropertyMetadata(false, (d, e) => ((MuiAddServerModal)d)._shell.IsOpen = (bool)e.NewValue));

        public static readonly DependencyProperty ContainedProperty =
            DependencyProperty.Register(nameof(Contained), typeof(bool), typeof(MuiAddServerModal),
                new PropertyMetadata(false, (d, e) => ((MuiAddServerModal)d)._shell.Contained = (bool)e.NewValue));

        public static readonly DependencyProperty ErrorMessageProperty =
            DependencyProperty.Register(nameof(ErrorMessage), typeof(string), typeof(MuiAddServerModal),
                new PropertyMetadata(null, (d, _) => ((MuiAddServerModal)d).Rebuild()));

        public static readonly DependencyProperty IsConnectingProperty =
            DependencyProperty.Register(nameof(IsConnecting), typeof(bool), typeof(MuiAddServerModal),
                new PropertyMetadata(false, (d, _) => ((MuiAddServerModal)d).Rebuild()));

        public bool IsOpen { get => (bool)GetValue(IsOpenProperty); set => SetValue(IsOpenProperty, value); }
        public bool Contained { get => (bool)GetValue(ContainedProperty); set => SetValue(ContainedProperty, value); }
        public string? ErrorMessage { get => (string?)GetValue(ErrorMessageProperty); set => SetValue(ErrorMessageProperty, value); }
        public bool IsConnecting { get => (bool)GetValue(IsConnectingProperty); set => SetValue(IsConnectingProperty, value); }

        public event EventHandler? Dismissed;
        public event EventHandler<MuiServerConnection>? ConnectRequested;

        private readonly MuiOverlayShell _shell = new() { Size = MuiOverlayShellSize.Sm, AriaLabel = "Add Server" };
        private readonly MuiBanner _errorBanner = new() { Variant = MuiBannerVariant.Error, Visibility = Visibility.Collapsed };
        private readonly MuiInput _address = new() { Placeholder = "maple.example.com" };
        private readonly MuiInput _username = new() { Placeholder = "Username" };
        private readonly MuiInput _password = new() { Placeholder = "Password" };
        private readonly MuiButton _cancel = new() { Variant = MuiButtonVariant.Ghost, Label = "Cancel" };
        private readonly MuiButton _connect = new() { Variant = MuiButtonVariant.Primary, Label = "Connect" };

        public MuiAddServerModal()
        {
            var body = new StackPanel { Orientation = Orientation.Vertical, Spacing = 14 };
            body.Children.Add(_errorBanner);
            body.Children.Add(new MuiFormField { Label = "Server address", ControlContent = _address });
            body.Children.Add(new MuiFormField { Label = "Username", ControlContent = _username });
            body.Children.Add(new MuiFormField { Label = "Password", ControlContent = _password });

            var footer = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
            footer.Children.Add(_cancel);
            footer.Children.Add(_connect);

            _shell.Header = new MuiText { Text = "Add Server", Variant = MuiTextVariant.SheetTitle };
            _shell.Body = body;
            _shell.Footer = footer;
            Content = _shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _shell.Dismissed += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _cancel.Click += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _connect.Click += (_, _) => ConnectRequested?.Invoke(this, new MuiServerConnection(_address.Text, _username.Text, _password.Text));

            Rebuild();
        }

        private void Rebuild()
        {
            _errorBanner.Visibility = string.IsNullOrEmpty(ErrorMessage) ? Visibility.Collapsed : Visibility.Visible;
            _errorBanner.Message = ErrorMessage ?? string.Empty;
            _connect.IsEnabled = !IsConnecting;
            _connect.IsLoading = IsConnecting;
        }
    }
}
