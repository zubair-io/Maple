using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Maple.UI;

namespace Maple.UI.Gallery
{
    /// <summary>§2.7 Media specimens for the Molecules L1 gallery page
    /// (wave N3b, #3012) — see MuiGalleryWindow.MoleculesL1.cs for the
    /// section split rationale. MapAnnotation, PreviewImage, VideoPlayer,
    /// AudioPlayer, DragPreview, CodeBlock.</summary>
    public sealed partial class MuiGalleryWindow
    {
        private void BuildMediaSpecimens(StackPanel panel)
        {
            panel.Children.Add(SectionHeading("Media"));

            AddSpecimen(panel, "Map Annotation", "Thumbnail pin or count cluster.", Row(
                new MuiMapAnnotation { Source = SolidBitmap(0x9C, 0x6A, 0xC4), Label = "Kyoto", Count = 12 },
                new MuiMapAnnotation { Label = "No photo" }));

            AddSpecimen(panel, "Preview Image", "Static image with load lifecycle.", Row(
                new MuiPreviewImage { Width = 96, Height = 72, Source = SolidBitmap(0x3A, 0x7C, 0xA8), AccessibleLabel = "Loaded preview" },
                new MuiPreviewImage { Width = 96, Height = 72, AccessibleLabel = "Loading preview" }));

            AddSpecimen(panel, "Video Player", "Playback with transport controls.", BuildVideoPlayerDemo());

            AddSpecimen(panel, "Audio Player", "Waveform-less audio transport.", BuildAudioPlayerDemo());

            AddSpecimen(panel, "Drag Preview", "Ghost shown while dragging.", Row(
                new MuiDragPreview { Source = SolidBitmap(0x4A, 0x8C, 0x5E), Count = 1 },
                new MuiDragPreview { Source = SolidBitmap(0xB8, 0x8A, 0x3A), Count = 5 }));

            AddSpecimen(panel, "Code Block", "Monospace block with copy.", new MuiCodeBlock
            {
                Language = "json",
                Code = "{\n  \"exposure\": 0.8,\n  \"temp\": 5200,\n  \"tint\": 4\n}",
            });
        }

        private static UIElement BuildVideoPlayerDemo()
        {
            var paused = new MuiVideoPlayer { DurationSeconds = 185 };
            paused.Transport.SetPosition(42);

            var playing = new MuiVideoPlayer { DurationSeconds = 74 };
            playing.Transport.SetPosition(30);
            playing.Transport.SetPlaying(true);

            return Row(paused, playing);
        }

        private static UIElement BuildAudioPlayerDemo()
        {
            var track = new MuiAudioPlayer { Title = "voice-memo-014.m4a", DurationSeconds = 96 };
            track.Transport.SetPosition(18);
            return track;
        }
    }
}
