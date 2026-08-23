using System;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Gallery
{
    /// <summary>Organisms §4.4 Modals gallery specimens, part 1 (Export,
    /// Batch Rename, Batch Metadata, Move To, Panorama Merge, Selective
    /// Paste, Library Picker) — wave N6 second push (#3012). Every modal
    /// demos <c>Contained</c>, closed by default, with an "Open" trigger
    /// sharing a Grid cell — the same AnchoredDemo shape
    /// MuiGalleryWindow.Templates.cs's own Overlay/Sheet/Drawer specimens
    /// use.</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildOrganismsModalsSpecimens(StackPanel panel)
        {
            AddSpecimen(panel, "Export", "Format/size/quality/color space, Export progress footer.",
                TemplateFrame(OpenDemo("Open Export", trigger =>
                {
                    var modal = new MuiExportModal { Contained = true, Settings = new MuiExportSettings("JPEG", "Full", 90, "sRGB") };
                    modal.Dismissed += (_, _) => modal.IsOpen = false;
                    trigger.Click += (_, _) => modal.IsOpen = true;
                    return modal;
                }), 340, 300));

            AddSpecimen(panel, "Batch Rename", "Live {date}_{seq} template preview.",
                TemplateFrame(OpenDemo("Open Batch Rename", trigger =>
                {
                    var modal = new MuiBatchRenameModal { Contained = true, Originals = new[] { "IMG_0001.dng", "IMG_0002.dng", "IMG_0003.dng" } };
                    modal.Dismissed += (_, _) => modal.IsOpen = false;
                    trigger.Click += (_, _) => modal.IsOpen = true;
                    return modal;
                }), 340, 340));

            AddSpecimen(panel, "Batch Metadata", "Multi-field edit gated by a confirm Dialog.",
                TemplateFrame(OpenDemo("Open Batch Metadata", trigger =>
                {
                    var modal = new MuiBatchMetadataModal { Contained = true, AssetCount = 12 };
                    modal.Dismissed += (_, _) => modal.IsOpen = false;
                    trigger.Click += (_, _) => modal.IsOpen = true;
                    return modal;
                }), 340, 320));

            AddSpecimen(panel, "Move To", "Flattened-tree destination picker with filter.",
                TemplateFrame(OpenDemo("Open Move To", trigger =>
                {
                    var modal = new MuiMoveToModal
                    {
                        Contained = true,
                        Roots = new[] { new MuiSidebarNode("albums", "Albums", "folder", Children: new[] { new MuiSidebarNode("wedding", "Wedding 2026", "folder") }) },
                    };
                    modal.Dismissed += (_, _) => modal.IsOpen = false;
                    trigger.Click += (_, _) => modal.IsOpen = true;
                    return modal;
                }), 300, 300));

            AddSpecimen(panel, "Panorama Merge", "Source frames, projection, stitch progress.",
                TemplateFrame(OpenDemo("Open Panorama Merge", trigger =>
                {
                    var modal = new MuiPanoramaMergeModal
                    {
                        Contained = true,
                        Frames = new[]
                        {
                            new MuiPanoramaFrame("f1", SolidBitmap(120, 140, 200), "pano_01.dng"),
                            new MuiPanoramaFrame("f2", SolidBitmap(140, 160, 210), "pano_02.dng"),
                            new MuiPanoramaFrame("f3", SolidBitmap(160, 180, 220), "pano_03.dng"),
                        },
                    };
                    modal.Dismissed += (_, _) => modal.IsOpen = false;
                    trigger.Click += (_, _) => modal.IsOpen = true;
                    return modal;
                }), 420, 320));

            AddSpecimen(panel, "Selective Paste", "Per-group apply toggles.",
                TemplateFrame(OpenDemo("Open Selective Paste", trigger =>
                {
                    var modal = new MuiSelectivePasteModal
                    {
                        Contained = true,
                        Groups = new[] { new MuiSelectivePasteGroup("light", "Light"), new MuiSelectivePasteGroup("color", "Color"), new MuiSelectivePasteGroup("effects", "Effects") },
                        SelectedGroupIds = new[] { "light" },
                    };
                    modal.Dismissed += (_, _) => modal.IsOpen = false;
                    trigger.Click += (_, _) => modal.IsOpen = true;
                    return modal;
                }), 280, 260));

            AddSpecimen(panel, "Library Picker", "Remote filesystem browser with Refresh/New Folder.",
                TemplateFrame(OpenDemo("Open Library Picker", trigger =>
                {
                    var modal = new MuiLibraryPickerModal { Contained = true, Roots = new[] { new MuiSidebarNode("shared", "Shared Drive", "folder") } };
                    modal.Dismissed += (_, _) => modal.IsOpen = false;
                    trigger.Click += (_, _) => modal.IsOpen = true;
                    return modal;
                }), 300, 320));
        }

        /// <summary>Shared modal-demo shape: an "Open" MuiButton plus the
        /// modal it opens, sharing one Grid cell so the modal's own
        /// Contained popup has a real anchor.</summary>
        private static UIElement OpenDemo(string label, Func<MuiButton, UIElement> build)
        {
            var trigger = new MuiButton
            {
                Variant = MuiButtonVariant.Secondary,
                Label = label,
                HorizontalAlignment = HorizontalAlignment.Center,
                VerticalAlignment = VerticalAlignment.Center,
            };
            var modal = build(trigger);
            var host = new Grid();
            host.Children.Add(trigger);
            host.Children.Add(modal);
            return host;
        }
    }
}
