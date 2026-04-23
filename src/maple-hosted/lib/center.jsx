// Center panel — thumbnail grid (Browse mode) and full image (Full-image mode).

function GridToolbar({ breadcrumb, thumbSize, setThumbSize, sort, setSort, filter, setFilter, selectedCount, total }) {
  return (
    <div style={{
      height: 40, display: 'flex', alignItems: 'center', gap: 12,
      padding: '0 14px',
      background: MapleTokens.bg,
      borderBottom: `0.5px solid ${MapleTokens.border}`,
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: MapleFont, fontSize: 11 }}>
        {breadcrumb.map((b, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span style={{ color: MapleTokens.textMuted, margin: '0 2px' }}>›</span>}
            <span style={{ color: i === breadcrumb.length - 1 ? MapleTokens.textMain : MapleTokens.textMuted }}>
              {b}
            </span>
          </React.Fragment>
        ))}
      </div>

      <div style={{ flex: 1 }}/>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontFamily: MapleFont, fontSize: 11, color: MapleTokens.textMuted,
      }}>
        <MapleIcon name="grid-sm" size={11}/>
        <input type="range" min={60} max={220} value={thumbSize}
          onChange={e => setThumbSize(Number(e.target.value))}
          style={{ width: 80, accentColor: MapleTokens.primary, cursor: 'pointer' }}/>
        <MapleIcon name="grid-lg" size={13}/>
      </div>

      <div style={{ width: 0.5, height: 18, background: MapleTokens.border }}/>

      <PillButton active={sort === 'date'} onClick={() => setSort(sort === 'date' ? 'name' : 'date')}>
        <MapleIcon name="sort" size={11}/>
        <span>{sort === 'date' ? 'Date' : 'Name'}</span>
      </PillButton>
      <PillButton active={filter !== 'all'} onClick={() => setFilter(filter === 'all' ? 'picks' : filter === 'picks' ? '4stars' : 'all')}>
        <MapleIcon name="filter" size={11}/>
        <span>{filter === 'all' ? 'All' : filter === 'picks' ? 'Picks' : '4+ stars'}</span>
      </PillButton>

      <div style={{ width: 0.5, height: 18, background: MapleTokens.border }}/>

      <span style={{
        fontFamily: MapleMono, fontSize: 10, color: MapleTokens.textMuted,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {selectedCount > 0 ? `${selectedCount} selected` : `${total} photos`}
      </span>
    </div>
  );
}

function PillButton({ active, onClick, children }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 4,
        height: 22, padding: '0 8px', borderRadius: 4,
        background: active ? MapleTokens.primaryDim : (hover ? MapleTokens.surfaceHover : MapleTokens.surface),
        color: active ? MapleTokens.primary : MapleTokens.textMain,
        fontFamily: MapleFont, fontSize: 11,
        border: `0.5px solid ${active ? MapleTokens.primary : MapleTokens.border}`,
        cursor: 'pointer',
        transition: 'background 120ms',
      }}
    >{children}</div>
  );
}

function MapleGrid({ images, selectedIds, onSelect, onOpen, thumbSize = 140 }) {
  // Justified rows: fill each row to container width, preserving aspect ratios.
  // Simple algorithm — accumulate aspect ratios until the row exceeds containerWidth/targetHeight,
  // then scale that row's thumbnails to match container width.
  const containerRef = React.useRef(null);
  const [containerWidth, setContainerWidth] = React.useState(800);

  React.useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        setContainerWidth(e.contentRect.width);
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const GAP = 3;
  const targetH = thumbSize;
  const rows = [];
  let row = [];
  let rowAr = 0;
  for (const img of images) {
    row.push(img);
    rowAr += img.ar;
    // Width at target height = rowAr * targetH + gaps
    const rowWidth = rowAr * targetH + (row.length - 1) * GAP;
    if (rowWidth >= containerWidth * 0.92) {
      rows.push(row);
      row = [];
      rowAr = 0;
    }
  }
  if (row.length) rows.push(row);

  return (
    <div
      ref={containerRef}
      style={{
        flex: 1,
        background: MapleTokens.bg,
        overflowY: 'auto',
        padding: 3,
      }}
    >
      {rows.map((r, ri) => {
        const totalAr = r.reduce((s, img) => s + img.ar, 0);
        const availW = containerWidth - (r.length - 1) * GAP - 6; // minus padding
        const h = Math.min(targetH * 1.4, availW / totalAr);
        return (
          <div key={ri} style={{ display: 'flex', gap: GAP, marginBottom: GAP }}>
            {r.map(img => (
              <MapleThumb
                key={img.id}
                src={img.thumb}
                ar={img.ar}
                edited={img.edited}
                rating={img.stars}
                flag={img.flag}
                selected={selectedIds.has(img.id)}
                onClick={(e) => onSelect(img.id, e)}
                onDoubleClick={() => onOpen(img.id)}
                style={{ width: img.ar * h, height: h, flexShrink: 0 }}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}

// Full-image view — letterboxed image with zoom indicator, centered.
function MapleFullImage({ image, zoom, setZoom, showBeforeAfter, setShowBeforeAfter }) {
  const [divider, setDivider] = React.useState(0.5);
  const dragRef = React.useRef(null);

  const onDrag = (e) => {
    if (!dragRef.current) return;
    const startX = e.clientX;
    const rect = dragRef.current.getBoundingClientRect();
    const startDivider = divider;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      setDivider(Math.max(0.05, Math.min(0.95, startDivider + dx / rect.width)));
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div style={{
      flex: 1, position: 'relative', background: MapleTokens.imageCanvas,
      overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div
        ref={dragRef}
        style={{
          maxWidth: '92%', maxHeight: '92%',
          aspectRatio: `${image.ar}`, position: 'relative',
          boxShadow: '0 6px 40px rgba(0,0,0,0.6)',
          transform: `scale(${zoom})`, transformOrigin: 'center',
          transition: 'transform 220ms cubic-bezier(0.22,1,0.36,1)',
          width: image.ar >= 1 ? '92%' : 'auto',
          height: image.ar >= 1 ? 'auto' : '92%',
        }}
      >
        <div style={{
          position: 'absolute', inset: 0,
          background: `url("${image.thumb}") center/cover`,
        }}/>
        {showBeforeAfter && (
          <>
            <div style={{
              position: 'absolute', inset: 0,
              background: `url("${image.thumb}") center/cover`,
              filter: 'saturate(0.4) brightness(0.85) contrast(0.9)',
              clipPath: `inset(0 ${(1 - divider) * 100}% 0 0)`,
            }}/>
            <div style={{
              position: 'absolute', top: 0, bottom: 0, left: `${divider * 100}%`,
              width: 1, background: 'rgba(255,255,255,0.9)', transform: 'translateX(-0.5px)',
              cursor: 'ew-resize',
            }} onMouseDown={onDrag}>
              <div style={{
                position: 'absolute', top: '50%', left: '50%',
                transform: 'translate(-50%, -50%)',
                width: 22, height: 22, borderRadius: '50%',
                background: 'rgba(255,255,255,0.95)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: MapleMono, fontSize: 9, color: '#000',
              }}>⇆</div>
            </div>
            <div style={{
              position: 'absolute', top: 8, left: 8,
              fontFamily: MapleMono, fontSize: 10, color: 'rgba(255,255,255,0.8)',
              background: 'rgba(0,0,0,0.4)', padding: '2px 6px', borderRadius: 2,
              letterSpacing: '0.1em',
            }}>BEFORE</div>
            <div style={{
              position: 'absolute', top: 8, right: 8,
              fontFamily: MapleMono, fontSize: 10, color: 'rgba(255,255,255,0.8)',
              background: 'rgba(0,0,0,0.4)', padding: '2px 6px', borderRadius: 2,
              letterSpacing: '0.1em',
            }}>AFTER</div>
          </>
        )}
      </div>

      {/* Zoom indicator — bottom left */}
      <div style={{
        position: 'absolute', left: 12, bottom: 10,
        fontFamily: MapleMono, fontSize: 10, color: MapleTokens.textMuted,
        letterSpacing: 0.2,
      }}>
        {zoom === 1 ? 'Fit' : `${Math.round(zoom * 100)}%`}
      </div>

      {/* Filename overlay — top center, subtle */}
      <div style={{
        position: 'absolute', top: 10, left: 0, right: 0,
        display: 'flex', justifyContent: 'center', pointerEvents: 'none',
      }}>
        <div style={{
          fontFamily: MapleMono, fontSize: 10, color: MapleTokens.textMuted,
          background: 'rgba(20,18,16,0.6)', padding: '3px 8px', borderRadius: 2,
          letterSpacing: 0.3, backdropFilter: 'blur(6px)',
        }}>
          {image.file} · {image.w} × {image.h}
        </div>
      </div>
    </div>
  );
}

function IconButton({ children, onClick, active = false }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 4,
        height: 24, padding: '0 8px', borderRadius: 4,
        background: active ? MapleTokens.primaryDim : (hover ? MapleTokens.surfaceHover : 'transparent'),
        color: active ? MapleTokens.primary : MapleTokens.textMain,
        fontFamily: MapleFont, fontSize: 11,
        cursor: 'pointer', transition: 'background 120ms',
      }}
    >{children}</div>
  );
}

function FlagPills({ flag, setFlag }) {
  const Pill = ({ value, label, bg, color, borderColor }) => {
    const active = flag === value;
    return (
      <div
        onClick={() => setFlag(active ? 'none' : value)}
        style={{
          width: 22, height: 22, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: active ? bg : 'transparent',
          color: active ? color : MapleTokens.textMuted,
          border: `0.5px solid ${active ? (borderColor || color) : MapleTokens.border}`,
          cursor: 'pointer', fontFamily: MapleFont, fontSize: 10, fontWeight: 600,
        }}
        title={label}
      >
        {value === 'pick' ? 'P' : value === 'reject' ? '✕' : '—'}
      </div>
    );
  };
  return (
    <div style={{ display: 'flex', gap: 3 }}>
      <Pill value="pick"   label="Pick"   bg={MapleTokens.successBg} color={MapleTokens.successText}/>
      <Pill value="none"   label="Unflagged" bg={MapleTokens.surfaceAlt} color={MapleTokens.textMain}/>
      <Pill value="reject" label="Reject" bg={MapleTokens.errorBg}   color={MapleTokens.errorText}/>
    </div>
  );
}

Object.assign(window, { MapleGrid, MapleFullImage, GridToolbar, PillButton, IconButton, FlagPills });
