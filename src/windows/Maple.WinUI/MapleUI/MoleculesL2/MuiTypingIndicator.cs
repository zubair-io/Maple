using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Typing Indicator molecule (unified-component-catalog.md
    /// §3, "Typing Indicator" row: "Someone-is-typing affordance", built
    /// from Avatar, Text) — an Xs avatar, "{name} is typing", and three
    /// dots pulsing in a staggered loop (a per-dot opacity
    /// <see cref="Storyboard"/> with <see cref="Timeline.RepeatBehavior"/>
    /// set to Forever and an increasing <see cref="Timeline.BeginTime"/>
    /// per dot — the same conservative "simple visibility/opacity
    /// storyboard" approach <see cref="MuiCollapsible"/>'s fade-in
    /// already uses in this library, looped instead of one-shot).
    /// </summary>
    public sealed class MuiTypingIndicator : ContentControl
    {
        public static readonly DependencyProperty NameProperty =
            DependencyProperty.Register(nameof(Name), typeof(string), typeof(MuiTypingIndicator),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiTypingIndicator)d).Rebuild()));

        public string Name
        {
            get => (string)GetValue(NameProperty);
            set => SetValue(NameProperty, value);
        }

        private readonly StackPanel _root = new() { Orientation = Orientation.Horizontal, Spacing = 8 };
        private readonly MuiAvatar _avatar = new() { AvatarSize = MuiAvatarSize.Xs };
        private readonly MuiText _label = new() { Variant = MuiTextVariant.ChipLabel, ColorRole = MuiTextColorRole.Muted };
        private readonly StackPanel _dots = new() { Orientation = Orientation.Horizontal, Spacing = 3, VerticalAlignment = VerticalAlignment.Center };

        public MuiTypingIndicator()
        {
            _root.Children.Add(_avatar);
            _root.Children.Add(_label);
            _root.Children.Add(_dots);
            Content = _root;
            IsTabStop = false;

            BuildDots();
            Rebuild();
        }

        private static Brush R(string key) => (Brush)Application.Current.Resources[key];

        private void BuildDots()
        {
            for (var i = 0; i < 3; i++)
            {
                var dot = new Border
                {
                    Width = 5,
                    Height = 5,
                    CornerRadius = new CornerRadius(2.5),
                    Background = R("MapleTextMuted"),
                };

                var pulse = new DoubleAnimation
                {
                    From = 0.25,
                    To = 1.0,
                    Duration = new Duration(TimeSpan.FromMilliseconds(400)),
                    AutoReverse = true,
                    BeginTime = TimeSpan.FromMilliseconds(i * 150),
                    RepeatBehavior = RepeatBehavior.Forever,
                };
                Storyboard.SetTarget(pulse, dot);
                Storyboard.SetTargetProperty(pulse, "Opacity");
                var storyboard = new Storyboard();
                storyboard.Children.Add(pulse);
                storyboard.Begin();

                _dots.Children.Add(dot);
            }
        }

        private void Rebuild()
        {
            _avatar.Name = Name;
            _label.Text = string.IsNullOrEmpty(Name) ? "typing" : $"{Name} is typing";
            AutomationProperties.SetName(this, _label.Text);
        }
    }
}
