// Tiny stroke icons tuned for 14–16px use.
function MapleIcon({ name, size = 14, color = 'currentColor', strokeWidth = 1.5, style = {} }) {
  const s = size;
  const p = { fill: 'none', stroke: color, strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round' };
  const common = { width: s, height: s, viewBox: '0 0 16 16', style: { display: 'block', ...style } };
  switch (name) {
    case 'chevron-right': return <svg {...common}><path {...p} d="M6 3l5 5-5 5"/></svg>;
    case 'chevron-down':  return <svg {...common}><path {...p} d="M3 6l5 5 5-5"/></svg>;
    case 'folder':        return <svg {...common}><path {...p} d="M2 5a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V5z"/></svg>;
    case 'folder-open':   return <svg {...common}><path {...p} d="M2 5a1 1 0 011-1h3l1.5 1.5H13a1 1 0 011 1v.5H2.5L2 12a1 1 0 001 1h10l1-5.5"/></svg>;
    case 'photos':        return <svg {...common}><rect {...p} x="2.5" y="3.5" width="11" height="9" rx="1.5"/><circle {...p} cx="6" cy="7" r="1"/><path {...p} d="M13 10l-3-3-5 5"/></svg>;
    case 'heart':         return <svg {...common}><path {...p} d="M8 13s-5-2.8-5-6.3A2.7 2.7 0 018 5a2.7 2.7 0 015 1.7C13 10.2 8 13 8 13z"/></svg>;
    case 'check':         return <svg {...common}><path {...p} d="M3 8l3.5 3.5L13 5"/></svg>;
    case 'x':             return <svg {...common}><path {...p} d="M4 4l8 8M12 4l-8 8"/></svg>;
    case 'plus':          return <svg {...common}><path {...p} d="M8 3v10M3 8h10"/></svg>;
    case 'search':        return <svg {...common}><circle {...p} cx="7" cy="7" r="4"/><path {...p} d="M10 10l3 3"/></svg>;
    case 'star':          return <svg {...common}><path {...p} d="M8 2.5l1.7 3.6 3.8.5-2.8 2.7.7 3.8L8 11.3 4.6 13.1l.7-3.8L2.5 6.6l3.8-.5L8 2.5z"/></svg>;
    case 'star-filled':   return <svg {...common}><path fill={color} d="M8 2.5l1.7 3.6 3.8.5-2.8 2.7.7 3.8L8 11.3 4.6 13.1l.7-3.8L2.5 6.6l3.8-.5L8 2.5z"/></svg>;
    case 'flag':          return <svg {...common}><path {...p} d="M4 2v12M4 3h8l-2 2.5L12 8H4"/></svg>;
    case 'dot':           return <svg {...common}><circle fill={color} cx="8" cy="8" r="2.5"/></svg>;
    case 'sort':          return <svg {...common}><path {...p} d="M4 4l2-2 2 2M6 2v10M12 12l-2 2-2-2M10 14V4"/></svg>;
    case 'filter':        return <svg {...common}><path {...p} d="M2.5 3.5h11l-4 5v4l-3 1.5V8.5l-4-5z"/></svg>;
    case 'grid-sm':       return <svg {...common}><rect {...p} x="2.5" y="2.5" width="3" height="3"/><rect {...p} x="6.5" y="2.5" width="3" height="3"/><rect {...p} x="10.5" y="2.5" width="3" height="3"/><rect {...p} x="2.5" y="6.5" width="3" height="3"/><rect {...p} x="6.5" y="6.5" width="3" height="3"/><rect {...p} x="10.5" y="6.5" width="3" height="3"/><rect {...p} x="2.5" y="10.5" width="3" height="3"/><rect {...p} x="6.5" y="10.5" width="3" height="3"/><rect {...p} x="10.5" y="10.5" width="3" height="3"/></svg>;
    case 'grid-lg':       return <svg {...common}><rect {...p} x="2.5" y="2.5" width="4.5" height="4.5"/><rect {...p} x="9" y="2.5" width="4.5" height="4.5"/><rect {...p} x="2.5" y="9" width="4.5" height="4.5"/><rect {...p} x="9" y="9" width="4.5" height="4.5"/></svg>;
    case 'info':          return <svg {...common}><circle {...p} cx="8" cy="8" r="5.5"/><path {...p} d="M8 7.5v3.5M8 5.5v.01"/></svg>;
    case 'droplet':       return <svg {...common}><path {...p} d="M8 2.5S3.5 7 3.5 10A4.5 4.5 0 008 14.5 4.5 4.5 0 0012.5 10C12.5 7 8 2.5 8 2.5z"/></svg>;
    case 'tag':           return <svg {...common}><path {...p} d="M2.5 8.5l6 6 6-6V2.5h-6l-6 6z"/><circle {...p} cx="10" cy="6" r="1"/></svg>;
    case 'scope':         return <svg {...common}><path {...p} d="M2 13h2l1-4 1 6 1-8 1 10 1-7 1 5 1-3 1 2h3"/></svg>;
    case 'back':          return <svg {...common}><path {...p} d="M10 3L5 8l5 5M5 8h9"/></svg>;
    case 'zoom-in':       return <svg {...common}><circle {...p} cx="7" cy="7" r="4"/><path {...p} d="M10 10l3 3M7 5v4M5 7h4"/></svg>;
    case 'zoom-out':      return <svg {...common}><circle {...p} cx="7" cy="7" r="4"/><path {...p} d="M10 10l3 3M5 7h4"/></svg>;
    case 'split':         return <svg {...common}><rect {...p} x="2.5" y="3.5" width="11" height="9" rx="1"/><path {...p} d="M8 3.5v9"/></svg>;
    case 'export':        return <svg {...common}><path {...p} d="M8 2.5v8M5 5.5l3-3 3 3M3 11v2a1 1 0 001 1h8a1 1 0 001-1v-2"/></svg>;
    case 'eyedrop':       return <svg {...common}><path {...p} d="M11 2.5l2.5 2.5-1.5 1.5L10.5 5l-5.5 5.5L3 12l-.5 1.5 1.5-.5 1.5-1.5L11 6l-1-1 1.5-1.5z"/></svg>;
    case 'map-pin':       return <svg {...common}><path {...p} d="M8 14s-4.5-4-4.5-7.5A4.5 4.5 0 018 2a4.5 4.5 0 014.5 4.5C12.5 10 8 14 8 14z"/><circle {...p} cx="8" cy="6.5" r="1.5"/></svg>;
    case 'camera':        return <svg {...common}><rect {...p} x="2.5" y="4.5" width="11" height="8" rx="1.5"/><circle {...p} cx="8" cy="8.5" r="2.5"/><path {...p} d="M6 4.5l1-1.5h2l1 1.5"/></svg>;
    case 'history':       return <svg {...common}><path {...p} d="M2.5 8a5.5 5.5 0 105.5-5.5c-1.8 0-3.4.9-4.4 2.3M2.5 2.5v2.5H5"/><path {...p} d="M8 5v3.2l2 1.3"/></svg>;
    case 'copy':          return <svg {...common}><rect {...p} x="5.5" y="5.5" width="8" height="8" rx="1"/><path {...p} d="M3.5 10.5v-7a1 1 0 011-1h7"/></svg>;
    case 'paste':         return <svg {...common}><rect {...p} x="3.5" y="4.5" width="9" height="9" rx="1"/><path {...p} d="M6 4.5V3h4v1.5M6 3h4"/></svg>;
    case 'revert':        return <svg {...common}><path {...p} d="M2.5 3v3.5H6"/><path {...p} d="M3 6.5A5.5 5.5 0 118 13.5"/></svg>;
    case 'sidebar':       return <svg {...common}><rect {...p} x="2" y="3.5" width="12" height="9" rx="1.5"/><path {...p} d="M6 3.5v9"/><path fill={color} stroke="none" d="M2.5 4.5H5.5v7H2.5z" opacity="0.3"/></svg>;
    case 'inspector':     return <svg {...common}><rect {...p} x="2" y="3.5" width="12" height="9" rx="1.5"/><path {...p} d="M10 3.5v9"/><path fill={color} stroke="none" d="M10.5 4.5H13.5v7H10.5z" opacity="0.3"/></svg>;
    case 'filmstrip':     return <svg {...common}><rect {...p} x="2.5" y="2.5" width="11" height="11" rx="1"/><path {...p} d="M4 4v8M12 4v8"/><path {...p} d="M4 7h1M4 9h1M11 7h1M11 9h1"/></svg>;
    default: return null;
  }
}

// Thumbnail placeholder — a subtly-textured swatch.
function MapleThumb({ src, ar = 3/2, edited = false, rating = 0, flag = 'none', selected = false, style = {}, onClick, onDoubleClick }) {
  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      style={{
        position: 'relative',
        aspectRatio: `${ar}`,
        background: `url("${src}") center/cover`,
        borderRadius: 2,
        cursor: 'pointer',
        outline: selected ? `2px solid ${MapleTokens.primary}` : 'none',
        outlineOffset: -2,
        ...style,
      }}
    >
      {/* XMP corner badge */}
      {edited && (
        <div style={{
          position: 'absolute', top: 5, right: 5,
          width: 14, height: 14, borderRadius: 3,
          background: MapleTokens.successBg,
          border: `0.5px solid ${MapleTokens.successText}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: MapleTokens.successText,
          backdropFilter: 'blur(4px)',
        }}>
          <MapleIcon name="check" size={9} strokeWidth={2}/>
        </div>
      )}
      {/* bottom-left badges: flag + stars */}
      <div style={{
        position: 'absolute', left: 5, bottom: 5, right: 5,
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
        gap: 4, pointerEvents: 'none',
      }}>
        <div style={{ display: 'flex', gap: 3 }}>
          {flag === 'pick' && <div style={{
            background: MapleTokens.successBg, color: MapleTokens.successText,
            fontSize: 9, fontWeight: 600, padding: '2px 4px', borderRadius: 3, letterSpacing: 0.3,
            fontFamily: MapleFont, backdropFilter: 'blur(4px)',
          }}>PICK</div>}
          {flag === 'reject' && <div style={{
            background: MapleTokens.errorBg, color: MapleTokens.errorText,
            fontSize: 9, fontWeight: 600, padding: '2px 4px', borderRadius: 3, letterSpacing: 0.3,
            fontFamily: MapleFont, backdropFilter: 'blur(4px)',
          }}>REJECT</div>}
        </div>
        {rating > 0 && (
          <div style={{ display: 'flex', gap: 1, background: 'rgba(0,0,0,0.45)', padding: '2px 4px', borderRadius: 3, backdropFilter: 'blur(4px)' }}>
            {[1,2,3,4,5].map(i => (
              <MapleIcon key={i} name={i <= rating ? 'star-filled' : 'star'}
                size={8} color={i <= rating ? MapleTokens.star : 'rgba(255,255,255,0.35)'}/>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Slider row — label left, current value right, themed range input.
function MapleSlider({ label, value, min, max, step = 1, unit = '', onChange, suffix }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{
          fontFamily: MapleFont, fontSize: 11, color: MapleTokens.textMuted, letterSpacing: 0.1,
        }}>{label}</span>
        <span style={{
          fontFamily: MapleMono, fontSize: 11, color: MapleTokens.textMain, fontVariantNumeric: 'tabular-nums',
        }}>{value > 0 && value !== 0 ? '+' : ''}{value}{unit}{suffix || ''}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange && onChange(Number(e.target.value))}
        style={{
          width: '100%', height: 14, accentColor: MapleTokens.primary, background: 'transparent',
          cursor: 'pointer',
        }}
      />
    </div>
  );
}

function MapleSectionHeader({ label, style = {} }) {
  return (
    <div style={{
      fontFamily: MapleFont, fontSize: 10, fontWeight: 600,
      color: MapleTokens.textMuted, letterSpacing: '0.08em',
      textTransform: 'uppercase', padding: '14px 14px 6px',
      ...style,
    }}>{label}</div>
  );
}

// Collapsible disclosure section — chevron rotates, content expands/collapses.
// State is persisted across reloads when `storageKey` is provided.
function MapleCollapsible({ label, defaultOpen = true, storageKey, children, right, padInner = true }) {
  const [open, setOpen] = React.useState(() => {
    if (!storageKey) return defaultOpen;
    try {
      const s = localStorage.getItem(`cm.coll.${storageKey}`);
      return s == null ? defaultOpen : s === '1';
    } catch { return defaultOpen; }
  });
  React.useEffect(() => {
    if (!storageKey) return;
    try { localStorage.setItem(`cm.coll.${storageKey}`, open ? '1' : '0'); } catch {}
  }, [open, storageKey]);
  return (
    <div style={{ borderBottom: `0.5px solid ${MapleTokens.border}` }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '9px 14px 9px 10px',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        <div style={{
          width: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform 140ms ease',
          color: MapleTokens.textMuted,
        }}>
          <MapleIcon name="chevron-right" size={10} color={MapleTokens.textMuted} strokeWidth={2}/>
        </div>
        <span style={{
          flex: 1,
          fontFamily: MapleFont, fontSize: 10, fontWeight: 600,
          color: MapleTokens.textMuted, letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}>{label}</span>
        {right}
      </div>
      {open && (
        <div style={{ padding: padInner ? '2px 0 10px' : 0 }}>
          {children}
        </div>
      )}
    </div>
  );
}

Object.assign(window, { MapleIcon, MapleThumb, MapleSlider, MapleSectionHeader, MapleCollapsible });
