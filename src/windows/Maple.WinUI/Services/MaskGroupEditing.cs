using System;
using System.Linq;
using Maple.WinUI.Generated;
using Maple.WinUI.Models;

namespace Maple.WinUI.Services
{
    /// <summary>Immutable mask edits shared by panel controls and canvas handles.</summary>
    public static class MaskGroupEditing
    {
        public static LocalMask? SelectedLeaf(LocalAdjustment? layer, int index) => layer?.Mask switch
        {
            MaskGroup group when index >= 0 && index < group.Components.Count => group.Components[index].Mask,
            LinearMask or RadialMask => layer.Mask,
            _ => null,
        };

        public static LocalAdjustment Add(LocalAdjustment layer, LocalMask leaf, MaskCombine combine)
        {
            var added = new MaskComponent(leaf, combine);
            var group = layer.Mask is MaskGroup existing ? existing
                : new MaskGroup(new[] { new MaskComponent(layer.Mask) });
            return layer with { Mask = new MaskGroup(group.Components.Append(added).ToArray(), group.Opacity, group.Invert) };
        }

        public static LocalAdjustment Remove(LocalAdjustment layer, int index)
        {
            if (layer.Mask is not MaskGroup group || group.Components.Count <= 1
                || index < 0 || index >= group.Components.Count) return layer;
            return layer with { Mask = new MaskGroup(group.Components.Where((_, i) => i != index).ToArray(), group.Opacity, group.Invert) };
        }

        private static LocalAdjustment Update(LocalAdjustment layer, int index, Func<MaskComponent, MaskComponent> edit)
        {
            if (layer.Mask is not MaskGroup group || index < 0 || index >= group.Components.Count) return layer;
            return layer with { Mask = new MaskGroup(group.Components.Select((component, i) => i == index ? edit(component) : component).ToArray(), group.Opacity, group.Invert) };
        }

        public static LocalAdjustment WithLeaf(LocalAdjustment layer, int index, Func<LocalMask, LocalMask> edit)
        {
            if (layer.Mask is not MaskGroup) return layer with { Mask = edit(layer.Mask) };
            return Update(layer, index, component => new MaskComponent(edit(component.Mask), component.Combine, component.Invert)
            { XmpSource = component.XmpSource });
        }

        public static LocalAdjustment WithCombine(LocalAdjustment layer, int index, MaskCombine combine) =>
            Update(layer, index, component => new MaskComponent(component.Mask, combine, component.Invert)
            { XmpSource = component.XmpSource });

        public static LocalAdjustment WithComponentInverted(LocalAdjustment layer, int index, bool invert) =>
            Update(layer, index, component => new MaskComponent(component.Mask, component.Combine, invert)
            { XmpSource = component.XmpSource });

        public static LocalAdjustment WithOpacity(LocalAdjustment layer, double opacity) =>
            double.IsFinite(opacity) && layer.Mask is MaskGroup group
                ? layer with { Mask = group with { Opacity = Math.Clamp(opacity, 0, 1) } } : layer;

        public static LocalAdjustment WithGroupInverted(LocalAdjustment layer, bool invert) =>
            layer.Mask is MaskGroup group ? layer with { Mask = group with { Invert = invert } } : layer;
    }
}
