using System;
using System.Collections.Generic;

namespace Maple.WinUI.Services
{
    /// <summary>What one touch event means for the zoom model, applied in
    /// this order: begin the drag, end the pinch, then a pinch frame, then a
    /// drag frame, then the drag end.</summary>
    public readonly record struct CanvasTouchUpdate(
        double? PinchEndedMagnification,
        (double Magnification, double X, double Y)? Pinch,
        (double X, double Y)? DragTranslation,
        bool DragEnded)
    {
        /// <summary>The first contact of a new gesture went down.</summary>
        public bool DragBegan { get; init; }
    }

    /// <summary>
    /// Turns raw touch contacts (viewport points) into the gesture values the
    /// shared zoom model expects: the first contact's translation, cumulative
    /// from its press, and — while two contacts are down — the pinch's
    /// cumulative magnification and centroid. The translation stays
    /// continuous when the first finger lifts and another carries on, so the
    /// model's post-pinch drag baseline holds.
    /// </summary>
    public sealed class CanvasTouchTracker
    {
        private readonly List<(uint Id, double X, double Y)> _contacts = new();
        private (double X, double Y) _dragOrigin;
        private (double X, double Y) _lastTranslation;
        private double _pinchStartDistance;
        private double _lastMagnification = 1;
        private bool _pinching;

        public int Count => _contacts.Count;

        public bool IsPinching => _pinching;

        /// <summary>Forget every contact (navigation or a mode change
        /// mid-gesture).</summary>
        public void Reset()
        {
            _contacts.Clear();
            _lastTranslation = (0, 0);
            _lastMagnification = 1;
            _pinching = false;
        }

        public CanvasTouchUpdate Press(uint id, double x, double y)
        {
            if (IndexOf(id) >= 0) return default;
            _contacts.Add((id, x, y));
            if (_contacts.Count == 1)
            {
                _dragOrigin = (x, y);
                _lastTranslation = (0, 0);
                return new CanvasTouchUpdate { DragBegan = true };
            }
            return _contacts.Count == 2 ? BeginPinch() : default;
        }

        public CanvasTouchUpdate Move(uint id, double x, double y)
        {
            var index = IndexOf(id);
            if (index < 0) return default;
            _contacts[index] = (id, x, y);
            var translation = index == 0 ? Translation() : ((double X, double Y)?)null;
            if (!_pinching || index > 1)
                return new CanvasTouchUpdate(null, null, translation, false);
            _lastMagnification = Magnification();
            var (cx, cy) = Centroid();
            return new CanvasTouchUpdate(null, (_lastMagnification, cx, cy), translation, false);
        }

        /// <summary>A lift, cancel or capture loss of one contact.</summary>
        public CanvasTouchUpdate Release(uint id)
        {
            var index = IndexOf(id);
            if (index < 0) return default;
            var endsPinch = _pinching && index <= 1;
            double? pinchEnded = endsPinch ? _lastMagnification : null;
            if (endsPinch) _pinching = false;
            _contacts.RemoveAt(index);
            if (_contacts.Count == 0)
                return new CanvasTouchUpdate(pinchEnded, null, null, true);
            if (index == 0)
            {
                var (x, y) = (_contacts[0].X, _contacts[0].Y);
                _dragOrigin = (x - _lastTranslation.X, y - _lastTranslation.Y);
            }
            if (endsPinch && _contacts.Count >= 2)
            {
                var next = BeginPinch();
                return next with { PinchEndedMagnification = pinchEnded };
            }
            return new CanvasTouchUpdate(pinchEnded, null, null, false);
        }

        private CanvasTouchUpdate BeginPinch()
        {
            _pinchStartDistance = Distance();
            _lastMagnification = 1;
            _pinching = true;
            var (cx, cy) = Centroid();
            // The drag frame lets the model take the primary contact's current
            // translation as its post-pinch baseline, so a drag made before
            // this pinch is not applied a second time afterwards.
            return new CanvasTouchUpdate(null, (1, cx, cy), _lastTranslation, false);
        }

        private (double X, double Y) Translation()
        {
            _lastTranslation = (_contacts[0].X - _dragOrigin.X, _contacts[0].Y - _dragOrigin.Y);
            return _lastTranslation;
        }

        private double Magnification()
        {
            var distance = Distance();
            return _pinchStartDistance > 0 && distance > 0 ? distance / _pinchStartDistance : _lastMagnification;
        }

        private double Distance() =>
            Math.Sqrt(Math.Pow(_contacts[1].X - _contacts[0].X, 2) + Math.Pow(_contacts[1].Y - _contacts[0].Y, 2));

        private (double X, double Y) Centroid() =>
            ((_contacts[0].X + _contacts[1].X) / 2, (_contacts[0].Y + _contacts[1].Y) / 2);

        private int IndexOf(uint id) => _contacts.FindIndex(contact => contact.Id == id);
    }
}
