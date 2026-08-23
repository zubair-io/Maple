using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI.Atoms;

namespace Maple.UI
{
    /// <summary>
    /// Maple.UI Response Viewer molecule (unified-component-catalog.md §3,
    /// "Response Viewer" row: "Formatted response with status", built from
    /// Code Block, Badge, Tabs) — an HTTP status badge, a Body/Headers
    /// <see cref="MuiTabs"/> switch, and a <see cref="MuiCodeBlock"/>
    /// showing whichever tab is active. Ports
    /// `mui-response-viewer.component.ts`'s <c>statusVariant</c> exactly
    /// (status &lt; 400 → Signal, else Count — the web port's own choice,
    /// not restyled here).
    /// </summary>
    public sealed class MuiResponseViewer : ContentControl
    {
        private static readonly IReadOnlyList<MuiTab> Tabs = new[]
        {
            new MuiTab("body", "Body"),
            new MuiTab("headers", "Headers"),
        };

        public static readonly DependencyProperty StatusProperty =
            DependencyProperty.Register(nameof(Status), typeof(int), typeof(MuiResponseViewer),
                new PropertyMetadata(200, (d, _) => ((MuiResponseViewer)d).Rebuild()));

        public static readonly DependencyProperty StatusTextProperty =
            DependencyProperty.Register(nameof(StatusText), typeof(string), typeof(MuiResponseViewer),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiResponseViewer)d).Rebuild()));

        public static readonly DependencyProperty BodyProperty =
            DependencyProperty.Register(nameof(Body), typeof(string), typeof(MuiResponseViewer),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiResponseViewer)d).Rebuild()));

        public static readonly DependencyProperty HeadersProperty =
            DependencyProperty.Register(nameof(Headers), typeof(string), typeof(MuiResponseViewer),
                new PropertyMetadata(string.Empty, (d, _) => ((MuiResponseViewer)d).Rebuild()));

        public static readonly DependencyProperty ActiveIdProperty =
            DependencyProperty.Register(nameof(ActiveId), typeof(string), typeof(MuiResponseViewer),
                new PropertyMetadata("body", (d, e) => { ((MuiResponseViewer)d)._tabs.ActiveId = (string)e.NewValue; ((MuiResponseViewer)d).Rebuild(); }));

        public int Status
        {
            get => (int)GetValue(StatusProperty);
            set => SetValue(StatusProperty, value);
        }

        public string StatusText
        {
            get => (string)GetValue(StatusTextProperty);
            set => SetValue(StatusTextProperty, value);
        }

        public string Body
        {
            get => (string)GetValue(BodyProperty);
            set => SetValue(BodyProperty, value);
        }

        public string Headers
        {
            get => (string)GetValue(HeadersProperty);
            set => SetValue(HeadersProperty, value);
        }

        public string ActiveId
        {
            get => (string)GetValue(ActiveIdProperty);
            set => SetValue(ActiveIdProperty, value);
        }

        private readonly StackPanel _root = new() { Orientation = Orientation.Vertical, Spacing = 10 };
        private readonly StackPanel _header = new() { Orientation = Orientation.Horizontal, Spacing = 12 };
        private readonly MuiBadge _statusBadge = new();
        private readonly MuiTabs _tabs = new() { Tabs = Tabs, ActiveId = "body" };
        private readonly MuiCodeBlock _codeBlock = new();

        public MuiResponseViewer()
        {
            _header.Children.Add(_statusBadge);
            _header.Children.Add(_tabs);
            _root.Children.Add(_header);
            _root.Children.Add(_codeBlock);
            Content = _root;
            IsTabStop = false;

            _tabs.SelectionChanged += (_, id) => ActiveId = id;

            Rebuild();
        }

        private void Rebuild()
        {
            _statusBadge.Variant = Status < 400 ? MuiBadgeVariant.Signal : MuiBadgeVariant.Count;
            _statusBadge.Value = $"{Status} {StatusText}".Trim();

            _codeBlock.Code = ActiveId == "headers" ? Headers : Body;
        }
    }
}
