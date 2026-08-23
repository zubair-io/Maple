using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Gallery
{
    /// <summary>Organisms §4.4 Modals gallery specimens, part 2 (Add
    /// Server, Pair Device, Share, Template Gallery, Card Detail, Result
    /// Report) — wave N6 second push (#3012).</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildOrganismsModalsBSpecimens(StackPanel panel)
        {
            AddSpecimen(panel, "Add Server", "Sign-in address/username/password.",
                TemplateFrame(OpenDemo("Open Add Server", trigger =>
                {
                    var modal = new MuiAddServerModal { Contained = true };
                    modal.Dismissed += (_, _) => modal.IsOpen = false;
                    trigger.Click += (_, _) => modal.IsOpen = true;
                    return modal;
                }), 300, 320));

            AddSpecimen(panel, "Pair Device", "Three-step Progress Step flow: show code / scan / connect.",
                TemplateFrame(OpenDemo("Open Pair Device", trigger =>
                {
                    var modal = new MuiPairDeviceModal { Contained = true, Payload = "maple-app://pair/abc123" };
                    modal.Dismissed += (_, _) => modal.IsOpen = false;
                    trigger.Click += (_, _) => modal.IsOpen = true;
                    return modal;
                }), 300, 420));

            AddSpecimen(panel, "Share", "Avatar Group summary, invite, per-member remove.",
                TemplateFrame(OpenDemo("Open Share", trigger =>
                {
                    var modal = new MuiShareModal
                    {
                        Contained = true,
                        Members = new[] { new MuiShareMember("m1", "Ada Lovelace", "Editor"), new MuiShareMember("m2", "Grace Hopper", "Viewer") },
                    };
                    modal.Dismissed += (_, _) => modal.IsOpen = false;
                    trigger.Click += (_, _) => modal.IsOpen = true;
                    return modal;
                }), 300, 340));

            AddSpecimen(panel, "Template Gallery", "Search-filtered template Cards.",
                TemplateFrame(OpenDemo("Open Template Gallery", trigger =>
                {
                    var modal = new MuiTemplateGalleryModal
                    {
                        Contained = true,
                        Templates = new[]
                        {
                            new MuiGalleryTemplate("t1", "Wedding Album", "12 pages"),
                            new MuiGalleryTemplate("t2", "Travel Journal", "8 pages"),
                            new MuiGalleryTemplate("t3", "Portfolio", "6 pages"),
                        },
                    };
                    modal.Dismissed += (_, _) => modal.IsOpen = false;
                    trigger.Click += (_, _) => modal.IsOpen = true;
                    return modal;
                }), 420, 360));

            AddSpecimen(panel, "Card Detail", "Title, Editable Chip Row labels, Rich Text Editor notes.",
                TemplateFrame(OpenDemo("Open Card Detail", trigger =>
                {
                    var modal = new MuiCardDetailModal
                    {
                        Contained = true,
                        Title = "Golden hour set",
                        Labels = new[] { new MuiChip("urgent", "Urgent") },
                        Notes = "Client wants warmer tones on the beach shots.",
                    };
                    modal.Dismissed += (_, _) => modal.IsOpen = false;
                    trigger.Click += (_, _) => modal.IsOpen = true;
                    return modal;
                }), 420, 420));

            AddSpecimen(panel, "Result Report", "Per-item batch outcome with success/fail Badges.",
                TemplateFrame(OpenDemo("Open Result Report", trigger =>
                {
                    var modal = new MuiResultReportModal
                    {
                        Contained = true,
                        Items = new[]
                        {
                            new MuiResultItem("i1", "DSC_0192.dng", MuiResultOutcome.Success),
                            new MuiResultItem("i2", "DSC_0193.dng", MuiResultOutcome.Failed, "Disk full"),
                            new MuiResultItem("i3", "DSC_0194.dng", MuiResultOutcome.Skipped, "Already exported"),
                        },
                    };
                    modal.Dismissed += (_, _) => modal.IsOpen = false;
                    trigger.Click += (_, _) => modal.IsOpen = true;
                    return modal;
                }), 340, 320));
        }
    }
}
