using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Pages
{
    /// <summary>
    /// Maple.UI Sign In page (unified-component-catalog.md §6 — App
    /// Shell template hosting Form Field, Button, and Banner). Windows
    /// Pages wave (#3012).
    ///
    /// Real wiring through <see cref="MuiSignInPageReducer"/>: the email
    /// and password Form Fields each validate independently (their own
    /// inline <see cref="MuiFormField.Error"/> updates as you type), and
    /// the submit Button only enables once both are clean — a Banner
    /// confirms success rather than the page silently doing nothing.
    /// </summary>
    public sealed class MuiPageSignIn : ContentControl
    {
        private readonly MuiInput _emailInput = new() { Placeholder = "you@justmaple.app" };
        private readonly MuiInput _passwordInput = new() { Placeholder = "Password" };
        private readonly MuiFormField _emailField = new() { Label = "Email" };
        private readonly MuiFormField _passwordField = new() { Label = "Password" };
        private readonly MuiButton _submit = new() { Label = "Sign In", Variant = MuiButtonVariant.Primary, IsEnabled = false };
        private readonly MuiBanner _banner = new() { Variant = MuiBannerVariant.Success, Visibility = Visibility.Collapsed };

        public MuiPageSignIn()
        {
            _emailField.ControlContent = _emailInput;
            _passwordField.ControlContent = _passwordInput;

            _emailInput.TextChanged += (_, _) => Revalidate();
            _passwordInput.TextChanged += (_, _) => Revalidate();
            _submit.Click += (_, _) =>
            {
                _banner.Message = $"Welcome back — signed in as {_emailInput.Text}.";
                _banner.Visibility = Visibility.Visible;
            };
            _banner.Dismissed += (_, _) => _banner.Visibility = Visibility.Collapsed;

            var card = new StackPanel
            {
                Orientation = Orientation.Vertical,
                Spacing = 16,
                Width = 360,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
                Children =
                {
                    new MuiText { Text = "Sign in to Maple", Variant = MuiTextVariant.SheetTitle },
                    _banner,
                    _emailField,
                    _passwordField,
                    _submit,
                },
            };

            var shell = new MuiAppShell { MainContent = card };
            Content = shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            Revalidate();
        }

        private void Revalidate()
        {
            _emailField.Error = MuiSignInPageReducer.EmailError(_emailInput.Text);
            _passwordField.Error = MuiSignInPageReducer.PasswordError(_passwordInput.Text);
            _submit.IsEnabled = MuiSignInPageReducer.CanSubmit(_emailInput.Text, _passwordInput.Text);
        }
    }
}
