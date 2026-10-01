using System;
using System.Collections.Generic;
using System.Linq;
using Maple.WinUI.Generated;

namespace Maple.WinUI.Models
{
    /// <summary>A leaf operation. Nested groups cannot enter the flat protocol.</summary>
    public sealed record MaskComponent
    {
        public LocalMask Mask { get; }
        public MaskCombine Combine { get; }
        public bool Invert { get; }
        /// <summary>Imported leaf metadata, retained while owned geometry is edited.</summary>
        public string? XmpSource { get; init; }

        public MaskComponent(LocalMask mask, MaskCombine combine = MaskCombine.Add, bool invert = false)
        {
            if (mask is not LinearMask && mask is not RadialMask)
                throw new ArgumentException("A component must be a supported leaf mask", nameof(mask));
            if (!Enum.IsDefined(combine))
                throw new ArgumentOutOfRangeException(nameof(combine));
            Mask = mask;
            Combine = combine;
            Invert = invert;
        }
    }

    /// <summary>One correction, with ordered component coverage followed by opacity.</summary>
    public sealed record MaskGroup : LocalMask
    {
        public IReadOnlyList<MaskComponent> Components { get; }
        public double Opacity { get; init; }
        public bool Invert { get; init; }

        public MaskGroup(IReadOnlyList<MaskComponent> components, double opacity = 1, bool invert = false)
        {
            Components = Array.AsReadOnly(components.ToArray());
            Opacity = opacity;
            Invert = invert;
        }

        public bool Equals(MaskGroup? other) => other is not null
            && Opacity.Equals(other.Opacity) && Invert == other.Invert
            && Components.SequenceEqual(other.Components);

        public override int GetHashCode()
        {
            var hash = new HashCode();
            hash.Add(Opacity);
            hash.Add(Invert);
            foreach (var component in Components) hash.Add(component);
            return hash.ToHashCode();
        }
    }
}
