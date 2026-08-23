using System.Collections.Generic;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;

namespace Maple.UI.Gallery
{
    /// <summary>Content-editing specimens for the Molecules L2 gallery page
    /// (wave N4, #3012) — see MuiGalleryWindow.MoleculesL2.cs for the
    /// section split rationale. VisionRow, KeywordRow, PreviewList,
    /// ProgressStep, SuggestionPreview.</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildMoleculesL2ContentSpecimens(StackPanel panel)
        {
            panel.Children.Add(SectionHeading("Content editing"));

            AddSpecimen(panel, "Vision Row", "Classification result chips.",
                new MuiVisionRow
                {
                    Labels = new[] { new MuiChip("water", "Water"), new MuiChip("sunset", "Sunset"), new MuiChip("boat", "Boat") },
                });

            AddSpecimen(panel, "Keyword Row", "Editable tag chips — add/remove mutate the backing list live.",
                BuildKeywordRowDemo());

            AddSpecimen(panel, "Preview List", "Before → after row list.",
                new MuiPreviewList
                {
                    Items = new[]
                    {
                        new MuiPreviewItem("p1", "IMG_0231.dng", "harbor-dusk-01.dng"),
                        new MuiPreviewItem("p2", "IMG_0244.dng", "harbor-dusk-02.dng"),
                    },
                });

            AddSpecimen(panel, "Progress Step", "One step of a wizard.", Column(
                new MuiProgressStep { Index = 0, Label = "Choose source", Status = MuiProgressStepStatus.Done },
                new MuiProgressStep { Index = 1, Label = "Configure sync", Status = MuiProgressStepStatus.Active },
                new MuiProgressStep { Index = 2, Label = "Review", Status = MuiProgressStepStatus.Pending }));

            AddSpecimen(panel, "Suggestion Preview", "Proposed change with accept/reject.", Column(
                new MuiSuggestionPreview { Description = "Rename \"IMG_0231.dng\" to \"harbor-dusk-01.dng\"" },
                new MuiSuggestionPreview { Description = "Set place to \"Golden Gate Park\"", Resolved = MuiSuggestionResolution.Accepted }));
        }

        private static UIElement BuildKeywordRowDemo()
        {
            var keywords = new List<MuiChip> { new("water", "Water"), new("dusk", "Dusk") };
            var row = new MuiKeywordRow { Keywords = keywords };

            row.Removed += (_, id) =>
            {
                keywords = new List<MuiChip>(MuiKeywordRowLogic.Remove(keywords, id));
                row.Keywords = keywords;
            };
            row.Added += (_, label) =>
            {
                keywords = new List<MuiChip>(MuiKeywordRowLogic.Add(keywords, label));
                row.Keywords = keywords;
            };
            return row;
        }
    }
}
