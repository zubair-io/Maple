using System;
using System.Threading;
using System.Threading.Tasks;

namespace Maple.WinUI.Services;

public sealed partial class RenderScheduler
{
    public event Action? DetailInvalidated;
    public DecodedImage? DetailSource { get { lock (_gate) return _image; } }
    // Check on the UI dispatcher, not only when the worker emits a frame:
    // selection/decode replacement can invalidate an already queued callback.
    public bool IsCurrentFrame(DecodedImage source)
    {
        lock (_gate) return !_stopping &&
            (ReferenceEquals(source, _image) || ReferenceEquals(source, _halfImage));
    }
    private void InvalidateDetail() => DetailInvalidated?.Invoke();
    internal Task<FilmLut?> LoadDetailFilmAsync(string look, CancellationToken cancellation) => _filmCache.LoadAsync(look, cancellation);
}
