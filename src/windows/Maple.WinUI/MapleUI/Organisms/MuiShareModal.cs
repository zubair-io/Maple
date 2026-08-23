using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One person with access to a shared item.</summary>
    public sealed record MuiShareMember(string Id, string Name, string Role);

    /// <summary>
    /// Maple.UI Share modal organism (unified-component-catalog.md §4.4,
    /// "Share" row: "Manage members and access", built from Avatar Group,
    /// Form Field, List Row) — an <see cref="MuiAvatarGroup"/> summary,
    /// an invite-by-name <see cref="MuiFormField"/>, and one
    /// <see cref="MuiListRow"/> per member with a Remove action.
    /// </summary>
    public sealed class MuiShareModal : ContentControl
    {
        public static readonly DependencyProperty IsOpenProperty =
            DependencyProperty.Register(nameof(IsOpen), typeof(bool), typeof(MuiShareModal),
                new PropertyMetadata(false, (d, e) => ((MuiShareModal)d)._shell.IsOpen = (bool)e.NewValue));

        public static readonly DependencyProperty ContainedProperty =
            DependencyProperty.Register(nameof(Contained), typeof(bool), typeof(MuiShareModal),
                new PropertyMetadata(false, (d, e) => ((MuiShareModal)d)._shell.Contained = (bool)e.NewValue));

        public static readonly DependencyProperty MembersProperty =
            DependencyProperty.Register(nameof(Members), typeof(IReadOnlyList<MuiShareMember>), typeof(MuiShareModal),
                new PropertyMetadata(null, (d, _) => ((MuiShareModal)d).Rebuild()));

        public bool IsOpen { get => (bool)GetValue(IsOpenProperty); set => SetValue(IsOpenProperty, value); }
        public bool Contained { get => (bool)GetValue(ContainedProperty); set => SetValue(ContainedProperty, value); }

        public IReadOnlyList<MuiShareMember>? Members
        {
            get => (IReadOnlyList<MuiShareMember>?)GetValue(MembersProperty);
            set => SetValue(MembersProperty, value);
        }

        public event EventHandler? Dismissed;
        public event EventHandler<string>? InviteRequested;
        public event EventHandler<string>? MemberRemoved;

        private readonly MuiOverlayShell _shell = new() { Size = MuiOverlayShellSize.Sm, AriaLabel = "Share" };
        private readonly MuiAvatarGroup _avatarGroup = new() { AvatarGroupSize = MuiAvatarSize.Md };
        private readonly MuiInput _invite = new() { Placeholder = "Invite by name or email" };
        private readonly MuiButton _inviteButton = new() { Variant = MuiButtonVariant.Secondary, Label = "Invite" };
        private readonly StackPanel _rows = new() { Orientation = Orientation.Vertical, Spacing = 2 };
        private readonly MuiButton _done = new() { Variant = MuiButtonVariant.Primary, Label = "Done" };

        public MuiShareModal()
        {
            var inviteRow = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
            inviteRow.Children.Add(_invite);
            inviteRow.Children.Add(_inviteButton);

            var body = new StackPanel { Orientation = Orientation.Vertical, Spacing = 14 };
            body.Children.Add(_avatarGroup);
            body.Children.Add(new MuiFormField { Label = "Invite", ControlContent = inviteRow });
            body.Children.Add(_rows);

            var footer = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, HorizontalAlignment = HorizontalAlignment.Right };
            footer.Children.Add(_done);

            _shell.Header = new MuiText { Text = "Share", Variant = MuiTextVariant.SheetTitle };
            _shell.Body = body;
            _shell.Footer = footer;
            Content = _shell;
            HorizontalContentAlignment = HorizontalAlignment.Stretch;
            VerticalContentAlignment = VerticalAlignment.Stretch;

            _shell.Dismissed += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _done.Click += (_, _) => { IsOpen = false; Dismissed?.Invoke(this, EventArgs.Empty); };
            _inviteButton.Click += (_, _) => { if (!string.IsNullOrWhiteSpace(_invite.Text)) { InviteRequested?.Invoke(this, _invite.Text); _invite.Text = string.Empty; } };

            Rebuild();
        }

        private void Rebuild()
        {
            var members = Members ?? Array.Empty<MuiShareMember>();
            var avatars = new List<MuiAvatarGroupMember>();
            foreach (var member in members) avatars.Add(new MuiAvatarGroupMember(member.Name));
            _avatarGroup.Avatars = avatars;

            _rows.Children.Clear();
            foreach (var member in members)
            {
                var remove = new MuiButton { Variant = MuiButtonVariant.Ghost, ButtonSize = MuiButtonSize.Sm, Label = "Remove" };
                var memberId = member.Id;
                remove.Click += (_, _) => MemberRemoved?.Invoke(this, memberId);
                var trailing = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8 };
                trailing.Children.Add(new MuiBadge { Variant = MuiBadgeVariant.Signal, Value = member.Role });
                trailing.Children.Add(remove);
                _rows.Children.Add(new MuiListRow { Label = member.Name, IconName = "person-circle", TrailingContent = trailing });
            }
        }
    }
}
