using System.Threading;

namespace Maple.WinUI.ViewModels
{
    public partial class EditSessionViewModel
    {
        private volatile bool _disposed;

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            CancelPreviewRequest();
            _libraryCts?.Cancel();
            Interlocked.Increment(ref _decodeGeneration);
            CancelActiveDecode();
            // Stop rejects SetImage even if a decoder passed its generation
            // check just before disposal. Its native cancellation is advisory.
            Renderer.Dispose();
            ReleaseBrushRasters();
            _sidecarTimer?.Dispose();
            _undoTimer?.Dispose();
            _sidecarWatcher.Dispose();
            _libraryWatcher?.Dispose();
        }
    }
}
