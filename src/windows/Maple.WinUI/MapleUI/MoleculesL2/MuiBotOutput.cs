using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Bot Output molecule (unified-component-catalog.md §3,
    /// "Bot Output" row: "Streaming generated result", built from Text,
    /// Progress, Avatar) — an avatar plus generated text that, while
    /// <see cref="Streaming"/>, reveals progressively via a real WinUI
    /// <see cref="DispatcherTimer"/> ticking a plain, WinUI-free
    /// <see cref="MuiBotOutputTicker"/> — same "DispatcherTimer drives a
    /// testable plain-C# core" split <see cref="Atoms.MuiToastAutoDismissTimer"/>
    /// uses. Ports `mui-bot-output.component.ts`'s <c>ngOnChanges</c>
    /// restart-on-Text/Streaming-change contract exactly.
    /// </summary>
    public sealed class MuiBotOutput : ContentControl
    {
        public static readonly DependencyProperty TextProperty =
            DependencyProperty.Register(nameof(Text), typeof(string), typeof(MuiBotOutput),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiBotOutput)d).Restart()));

        public static readonly DependencyProperty StreamingProperty =
            DependencyProperty.Register(nameof(Streaming), typeof(bool), typeof(MuiBotOutput),
                new PropertyMetadata(false, (d, _) => ((MuiBotOutput)d).Restart()));

        public static readonly DependencyProperty BotNameProperty =
            DependencyProperty.Register(nameof(BotName), typeof(string), typeof(MuiBotOutput),
                new PropertyMetadata("Maple AI", (d, e) => ((MuiBotOutput)d)._avatar.Name = (string)e.NewValue));

        public static readonly DependencyProperty CharsPerTickProperty =
            DependencyProperty.Register(nameof(CharsPerTick), typeof(int), typeof(MuiBotOutput),
                new PropertyMetadata(2, (d, _) => ((MuiBotOutput)d).Restart()));

        public static readonly DependencyProperty IntervalMsProperty =
            DependencyProperty.Register(nameof(IntervalMs), typeof(int), typeof(MuiBotOutput),
                new PropertyMetadata(30, (d, e) => ((MuiBotOutput)d)._timer.Interval = TimeSpan.FromMilliseconds((int)e.NewValue)));

        public string Text
        {
            get => (string)GetValue(TextProperty);
            set => SetValue(TextProperty, value);
        }

        /// <summary>When true, <see cref="Text"/> is revealed progressively
        /// rather than shown whole.</summary>
        public bool Streaming
        {
            get => (bool)GetValue(StreamingProperty);
            set => SetValue(StreamingProperty, value);
        }

        public string BotName
        {
            get => (string)GetValue(BotNameProperty);
            set => SetValue(BotNameProperty, value);
        }

        public int CharsPerTick
        {
            get => (int)GetValue(CharsPerTickProperty);
            set => SetValue(CharsPerTickProperty, value);
        }

        public int IntervalMs
        {
            get => (int)GetValue(IntervalMsProperty);
            set => SetValue(IntervalMsProperty, value);
        }

        /// <summary>Fires once when the full Text has been revealed.</summary>
        public event EventHandler? Completed;

        private readonly StackPanel _root = new() { Orientation = Orientation.Horizontal, Spacing = 10 };
        private readonly MuiAvatar _avatar = new() { AvatarSize = MuiAvatarSize.Sm, Name = "Maple AI" };
        private readonly StackPanel _content = new() { Orientation = Orientation.Vertical, Spacing = 6 };
        private readonly MuiText _text = new() { Variant = MuiTextVariant.Body, ColorRole = MuiTextColorRole.Muted };
        private readonly MuiProgress _ring = new() { ProgressShape = MuiProgressShape.Ring, ProgressSize = MuiProgressSize.Sm, IsIndeterminate = true, Label = "Generating" };
        private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromMilliseconds(30) };

        private MuiBotOutputTicker _ticker = new(2);

        public MuiBotOutput()
        {
            _content.Children.Add(_text);
            _content.Children.Add(_ring);
            _root.Children.Add(_avatar);
            _root.Children.Add(_content);
            Content = _root;
            IsTabStop = false;

            _timer.Tick += (_, _) => OnTick();

            Restart();
        }

        private void OnTick()
        {
            _ticker.Tick((Text ?? string.Empty).Length);
            ApplyVisible();
            if (_ticker.VisibleLength >= (Text ?? string.Empty).Length)
            {
                _timer.Stop();
                Completed?.Invoke(this, EventArgs.Empty);
            }
        }

        private void Restart()
        {
            _timer.Stop();
            _ticker = new MuiBotOutputTicker(Math.Max(1, CharsPerTick));

            if (Streaming)
            {
                ApplyVisible();
                _timer.Start();
            }
            else
            {
                _ticker.RevealAll((Text ?? string.Empty).Length);
                ApplyVisible();
            }
        }

        private void ApplyVisible()
        {
            var text = Text ?? string.Empty;
            _text.Text = text.Substring(0, Math.Min(_ticker.VisibleLength, text.Length));
            _ring.Visibility = Streaming && _ticker.VisibleLength < text.Length ? Visibility.Visible : Visibility.Collapsed;
        }
    }
}
