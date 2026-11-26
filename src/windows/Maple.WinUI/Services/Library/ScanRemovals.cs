using System;
using System.Collections.Generic;
using System.Linq;
using Maple.WinUI.ViewModels;

namespace Maple.WinUI.Services
{
    internal sealed class ScanRemovals
    {
        private readonly object _gate = new();
        private readonly List<Scope> _active = new();

        public Scope Begin()
        {
            var scope = new Scope(this);
            lock (_gate)
                _active.Add(scope);
            return scope;
        }

        public void Removed(string path)
        {
            lock (_gate)
                foreach (var scope in _active)
                    scope.Paths.Add(path);
        }

        public void Present(string path)
        {
            lock (_gate)
                foreach (var scope in _active)
                    scope.Paths.Remove(path);
        }

        public sealed class Scope
        {
            private readonly ScanRemovals _owner;

            internal Scope(ScanRemovals owner) => _owner = owner;

            internal HashSet<string> Paths { get; } = new(StringComparer.OrdinalIgnoreCase);

            public List<PhotoItem> Surviving(List<PhotoItem> items)
            {
                lock (_owner._gate)
                    return items.Where(item => !Paths.Contains(item.FilePath)).ToList();
            }

            public void End()
            {
                lock (_owner._gate)
                    _owner._active.Remove(this);
            }
        }
    }
}
