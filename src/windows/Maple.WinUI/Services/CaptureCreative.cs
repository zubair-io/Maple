using System;
using Maple.WinUI.Native;

namespace Maple.WinUI.Services
{
    /// <summary>
    /// A capture decode's creative stage (#5377), copied out of the decode
    /// buffer once and pointed at by every tick's params. Pin it with
    /// <c>fixed (MapleCaptureCreative* c = image.Creative)</c>: a null box
    /// pins to a null pointer, which keeps the legacy white-balance delta for
    /// buffers that are not capture decodes (rasters). Immutable after
    /// construction, and its table pointer is valid for the life of the
    /// process, so one box is shared by every image derived from the decode.
    /// </summary>
    public sealed class CaptureCreative
    {
        private readonly MapleCaptureCreative[] _value = new MapleCaptureCreative[1];

        public CaptureCreative(in MapleCaptureCreative creative)
        {
            if (creative.present != 1)
                throw new InvalidOperationException("The capture decode returned no creative stage.");
            _value[0] = creative;
        }

        /// <summary>The exposure gain the creative stage applies, measured on
        /// the as-shot render.</summary>
        public float AeGain => _value[0].ae_gain;

        public ref readonly MapleCaptureCreative GetPinnableReference() => ref _value[0];
    }
}
