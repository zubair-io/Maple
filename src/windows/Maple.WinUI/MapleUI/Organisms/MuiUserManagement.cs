using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One user with access to a Self Hosted instance.</summary>
    public sealed record MuiManagedUser(string Id, string Name, string Role);

    /// <summary>
    /// Maple.UI User Management organism (unified-component-catalog.md
    /// §4.8, "User Management" row: "Invite, list, and revoke access",
    /// built from List Row, QR Code, Dialog, Form Field) — an invite
    /// <see cref="MuiFormField"/>; sending one reveals a persistent
    /// <see cref="MuiQrPlaceholder"/> invite code (Dialog has no generic
    /// body slot to host it in, so it renders inline rather than inside
    /// the confirm popup), a <see cref="MuiListRow"/> per user, and a
    /// confirm <see cref="MuiDialog"/> before revoking access.
    /// </summary>
    public sealed class MuiUserManagement : ContentControl
    {
        public static readonly DependencyProperty UsersProperty =
            DependencyProperty.Register(nameof(Users), typeof(IReadOnlyList<MuiManagedUser>), typeof(MuiUserManagement),
                new PropertyMetadata(null, (d, _) => ((MuiUserManagement)d).Rebuild()));

        public static readonly DependencyProperty InvitePayloadProperty =
            DependencyProperty.Register(nameof(InvitePayload), typeof(string), typeof(MuiUserManagement),
                new PropertyMetadata(string.Empty, (d, e) => ((MuiUserManagement)d)._qrCode.Payload = (string)e.NewValue));

        public IReadOnlyList<MuiManagedUser>? Users
        {
            get => (IReadOnlyList<MuiManagedUser>?)GetValue(UsersProperty);
            set => SetValue(UsersProperty, value);
        }

        public string InvitePayload { get => (string)GetValue(InvitePayloadProperty); set => SetValue(InvitePayloadProperty, value); }

        public event EventHandler<string>? InviteRequested;
        public event EventHandler<string>? UserRevoked;

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 16 };
        private readonly MuiInput _inviteInput = new() { Placeholder = "Invite by email" };
        private readonly MuiButton _inviteButton = new() { Variant = MuiButtonVariant.Secondary, Label = "Invite" };
        private readonly StackPanel _rows = new() { Orientation = Orientation.Vertical, Spacing = 2 };
        private readonly StackPanel _invitePanel = new() { Orientation = Orientation.Horizontal, Spacing = 12, Visibility = Visibility.Collapsed };
        private readonly MuiQrPlaceholder _qrCode = new() { PlaceholderSize = MuiQrPlaceholderSize.Md };
        private readonly MuiText _inviteCaption = new() { Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted, VerticalAlignment = VerticalAlignment.Center };
        private readonly MuiDialog _revokeDialog = new() { Variant = MuiDialogVariant.Confirm, Title = "Revoke access?", ConfirmLabel = "Revoke", Destructive = true };
        private string? _pendingRevokeId;

        public MuiUserManagement()
        {
            var inviteRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            inviteRow.Children.Add(_inviteInput);
            inviteRow.Children.Add(_inviteButton);

            _invitePanel.Children.Add(_qrCode);
            _invitePanel.Children.Add(_inviteCaption);

            _root.Children.Add(new MuiFormField { Label = "Invite a new member", ControlContent = inviteRow });
            _root.Children.Add(_invitePanel);
            _root.Children.Add(_rows);
            _root.Children.Add(_revokeDialog);
            Content = _root;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;

            _inviteButton.Click += (_, _) =>
            {
                if (string.IsNullOrWhiteSpace(_inviteInput.Text)) return;
                InviteRequested?.Invoke(this, _inviteInput.Text);
                _inviteCaption.Text = $"Share this code with {_inviteInput.Text}.";
                _invitePanel.Visibility = Visibility.Visible;
                _inviteInput.Text = string.Empty;
            };
            _revokeDialog.Confirmed += (_, _) =>
            {
                _revokeDialog.IsOpen = false;
                if (_pendingRevokeId is not null) UserRevoked?.Invoke(this, _pendingRevokeId);
            };
            _revokeDialog.Dismissed += (_, _) => _revokeDialog.IsOpen = false;

            Rebuild();
        }

        private void Rebuild()
        {
            _rows.Children.Clear();
            foreach (var user in Users ?? Array.Empty<MuiManagedUser>())
            {
                var revoke = new MuiButton { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm, Label = "Revoke" };
                var userId = user.Id;
                revoke.Click += (_, _) => { _pendingRevokeId = userId; _revokeDialog.Message = $"{user.Name} will lose access immediately."; _revokeDialog.IsOpen = true; };
                var trailing = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
                trailing.Children.Add(new MuiBadge { Variant = MuiBadgeVariant.Signal, Value = user.Role });
                trailing.Children.Add(revoke);
                _rows.Children.Add(new MuiListRow { Label = user.Name, IconName = "person-circle", TrailingContent = trailing });
            }
        }
    }
}
