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
            Interlocked.Increment(ref _decodeGeneration);
            CancelActiveDecode();
            // Stop rejects SetImage even if a decoder passed its generation
            // check just before disposal. Its native cancellation is advisory.
            Renderer.Dispose();
            _sidecarTimer?.Dispose();
            _undoTimer?.Dispose();
            _sidecarWatcher.Dispose();
            _libraryWatcher?.Dispose();
        }
    }
}
