using System;
using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>One member shown in an Avatar Group.</summary>
    public sealed record MuiAvatarGroupMember(string Name, ImageSource? Picture = null);

    /// <summary>
    /// Maple.UI Avatar Group molecule (unified-component-catalog.md §2.5,
    /// "Avatar Group" row: "Overlapping avatars with overflow", built from
    /// Avatar, Badge) — overlapping <see cref="MuiAvatar"/>s via negative
    /// margins, with a "+N" <see cref="MuiBadge"/> once the list exceeds
    /// <see cref="Max"/>. Split math (visible/overflow counts) lives in
    /// <see cref="MuiAvatarGroupMath"/>, ported from
    /// `mui-avatar-group.component.ts`'s `visible`/`overflowCount` computeds.
    /// </summary>
    public sealed class MuiAvatarGroup : ContentControl
    {
        public static readonly DependencyProperty AvatarsProperty =
            DependencyProperty.Register(nameof(Avatars), typeof(IReadOnlyList<MuiAvatarGroupMember>), typeof(MuiAvatarGroup),
                new PropertyMetadata(null, (d, _) => ((MuiAvatarGroup)d).Rebuild()));

        public static readonly DependencyProperty MaxProperty =
            DependencyProperty.Register(nameof(Max), typeof(int), typeof(MuiAvatarGroup),
                new PropertyMetadata(3, (d, _) => ((MuiAvatarGroup)d).Rebuild()));

        public static readonly DependencyProperty AvatarGroupSizeProperty =
            DependencyProperty.Register(nameof(AvatarGroupSize), typeof(MuiAvatarSize), typeof(MuiAvatarGroup),
                new PropertyMetadata(MuiAvatarSize.Sm, (d, _) => ((MuiAvatarGroup)d).Rebuild()));

        public IReadOnlyList<MuiAvatarGroupMember>? Avatars
        {
            get => (IReadOnlyList<MuiAvatarGroupMember>?)GetValue(AvatarsProperty);
            set => SetValue(AvatarsProperty, value);
        }

        public int Max
        {
            get => (int)GetValue(MaxProperty);
            set => SetValue(MaxProperty, value);
        }

        public MuiAvatarSize AvatarGroupSize
        {
            get => (MuiAvatarSize)GetValue(AvatarGroupSizeProperty);
            set => SetValue(AvatarGroupSizeProperty, value);
        }

        private readonly StackPanel _row = new() { Orientation = Orientation.Horizontal, Spacing = 0 };

        public MuiAvatarGroup()
        {
            Content = _row;
            IsTabStop = false;
            Rebuild();
        }

        private static double OverlapFor(MuiAvatarSize size) => size switch
        {
            MuiAvatarSize.Xs => 8,
            MuiAvatarSize.Md => 14,
            MuiAvatarSize.Lg => 18,
            _ => 10, // Sm
        };

        private void Rebuild()
        {
            _row.Children.Clear();

            var avatars = Avatars ?? Array.Empty<MuiAvatarGroupMember>();
            var visibleCount = MuiAvatarGroupMath.VisibleCount(avatars.Count, Max);
            var overflow = MuiAvatarGroupMath.OverflowCount(avatars.Count, Max);
            var overlap = OverlapFor(AvatarGroupSize);

            for (var i = 0; i < visibleCount; i++)
            {
                var avatar = new MuiAvatar
                {
                    Name = avatars[i].Name,
                    Picture = avatars[i].Picture,
                    AvatarSize = AvatarGroupSize,
                    Margin = i > 0 ? new Thickness(-overlap, 0, 0, 0) : new Thickness(0),
                };
                _row.Children.Add(avatar);
            }

            if (overflow > 0)
            {
                var badge = new MuiBadge
                {
                    Variant = MuiBadgeVariant.Count,
                    Value = "+" + overflow,
                    Label = overflow + " more",
                    Margin = visibleCount > 0 ? new Thickness(-overlap, 0, 0, 0) : new Thickness(0),
                };
                _row.Children.Add(badge);
            }
        }
    }
}
