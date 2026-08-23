using System.Linq;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;
using Maple.UI.Atoms;

namespace Maple.UI.Gallery
{
    /// <summary>Organisms §4.5 Editing gallery specimens, part 2 (Rich
    /// Text Editor, Whiteboard Canvas, Structured Data Editor, Preview
    /// Surface) — wave N6 second push (#3012).</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildOrganismsEditingBSpecimens(StackPanel panel)
        {
            AddSpecimen(panel, "Rich Text Editor", "RichEditBox body, selection Bubble Menu, Insert Command Menu, @-mentions, embeds, Code Block.", TemplateFrame(
                new MuiRichTextEditor
                {
                    Value = "Notes from the shoot.",
                    MentionSuggestions = new[] { new MuiSuggestionItem("ada", "Ada Lovelace") },
                    Embeds = new[] { new MuiRichTextEmbed("Client brief", "https://example.com/brief") },
                }, 340, 320));

            AddSpecimen(panel, "Whiteboard Canvas", "Pointer-captured Polyline strokes, Toolbar, AI prompt row.", TemplateFrame(
                new MuiWhiteboardCanvas(), 340, 320));

            AddSpecimen(panel, "Structured Data Editor", "Flat JSON as a generated form or as raw code.", Row(
                TemplateFrame(new MuiStructuredDataEditor { Json = """{"camera":"DJI Mavic 3 Pro","iso":"100"}""", View = MuiStructuredDataView.Form }, 260, 220),
                TemplateFrame(new MuiStructuredDataEditor { Json = """{"camera":"DJI Mavic 3 Pro"}""", View = MuiStructuredDataView.Code }, 260, 220)));

            AddSpecimen(panel, "Preview Surface", "Page Header, centered media, floating Toolbar, bottom Filmstrip.", TemplateFrame(
                new MuiPreviewSurface
                {
                    Title = "DSC_0192.dng",
                    Source = SolidBitmap(80, 120, 190),
                    ToolbarEntries = new[] { MuiToolbarEntry.For(new MuiToolbarItem("zoom-in", "zoom-in", "Zoom in")), MuiToolbarEntry.For(new MuiToolbarItem("share", "share-up-square", "Share")) },
                    FilmstripItems = SampleGridItems(5).Select(i => new MuiFilmstripItem(i.Id, i.Source, i.Alt)).ToList(),
                    ActiveId = "g1",
                }, 400, 340));
        }
    }
}
