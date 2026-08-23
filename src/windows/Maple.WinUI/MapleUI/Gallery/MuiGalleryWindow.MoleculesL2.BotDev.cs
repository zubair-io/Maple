using Microsoft.UI.Xaml.Controls;
using Maple.UI;

namespace Maple.UI.Gallery
{
    /// <summary>AI/dev-tool-family specimens for the Molecules L2 gallery
    /// page (wave N4, #3012) — see MuiGalleryWindow.MoleculesL2.cs for the
    /// section split rationale. BotOutput, EndpointForm, ResponseViewer,
    /// QrScanner.</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildMoleculesL2BotDevSpecimens(StackPanel panel)
        {
            panel.Children.Add(SectionHeading("AI & developer tools"));

            AddSpecimen(panel, "Bot Output", "Streaming generated result — the streaming specimen reveals live via a real DispatcherTimer.", Column(
                new MuiBotOutput { Text = "This photo shows a quiet harbor at dusk.", Streaming = false },
                new MuiBotOutput { Text = "Generating a caption for this batch of twelve photos…", Streaming = true, CharsPerTick = 1, IntervalMs = 45 }));

            AddSpecimen(panel, "Endpoint Form", "Interactive request builder.",
                new MuiEndpointForm { Method = "GET", Url = "/api/photos?limit=50" });

            AddSpecimen(panel, "Response Viewer", "Formatted response with status.",
                new MuiResponseViewer
                {
                    Status = 200,
                    StatusText = "OK",
                    Body = "{\n  \"count\": 50,\n  \"items\": [ ]\n}",
                    Headers = "content-type: application/json\ncache-control: no-store",
                });

            AddSpecimen(panel, "QR Scanner", "Paste-payload capture — camera is out of scope for Windows v1 (#3012).",
                new MuiQrScanner());
        }
    }
}
