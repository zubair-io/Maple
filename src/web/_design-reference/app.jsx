// App — assembles window chrome, toolbar, panels, and mode switching.

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#c4493a",
  "accentDim": "#422016",
  "sidebarVariant": "warm-charcoal",
  "gridDensity": "medium",
  "borderContrast": "normal",
  "showThumbBadges": true,
  "traceMode": false
}/*EDITMODE-END*/;

// Keep localStorage state for mode + selection so reloads feel smooth.
function usePersistedState(key, initial) {
  const [val, setVal] = React.useState(() => {
    try {
      const s = localStorage.getItem(key);
      return s ? JSON.parse(s) : initial;
    } catch { return initial; }
  });
  React.useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }, [key, val]);
  return [val, setVal];
}

function App() {
  const [mode, setMode] = usePersistedState('cm.mode', 'browse'); // browse | full
  const [source, setSource] = usePersistedState('cm.source', 'f-france');
  const [selected, setSelectedRaw] = usePersistedState('cm.selected', [3]); // array of ids
  const [activeId, setActiveId] = usePersistedState('cm.active', 3);
  const [tab, setTab] = usePersistedState('cm.tab', 'info');
  const [thumbSize, setThumbSize] = usePersistedState('cm.thumbSize', 140);
  const [sort, setSort] = usePersistedState('cm.sort', 'date');
  const [filter, setFilter] = usePersistedState('cm.filter', 'all');
  const [leftHidden, setLeftHidden] = usePersistedState('cm.leftHidden', false);
  const [detailHidden, setDetailHidden] = usePersistedState('cm.detailHidden', false);
  const [zoom, setZoom] = React.useState(1);
  const [showBA, setShowBA] = React.useState(false);
  const [adj, setAdj] = React.useState(DEFAULT_ADJ);
  const [ratings, setRatings] = React.useState({});
  const [flags, setFlags] = React.useState({});
  const [colorLabels, setColorLabels] = React.useState({});
  const [tweaks, setTweaks] = React.useState(TWEAK_DEFAULTS);
  const [tweaksOpen, setTweaksOpen] = React.useState(false);

  // Migrate legacy tab values from older localStorage schemas.
  React.useEffect(() => {
    if (tab === 'color' || tab === 'scopes') setTab('develop');
    else if (tab === 'meta') setTab('info');
  }, [tab]);
  React.useEffect(() => {
    const onMsg = (e) => {
      if (e.data?.type === '__activate_edit_mode') setTweaksOpen(true);
      if (e.data?.type === '__deactivate_edit_mode') setTweaksOpen(false);
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage({ type: '__edit_mode_available' }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // Keyboard shortcuts
  React.useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'Escape' && mode === 'full') { setMode('browse'); e.preventDefault(); }
      if (e.key === 'Enter' && mode === 'browse' && activeId) { setMode('full'); e.preventDefault(); }
      if (mode === 'full') {
        if (e.key === 'ArrowRight') { advance(1); e.preventDefault(); }
        if (e.key === 'ArrowLeft')  { advance(-1); e.preventDefault(); }
      }
      // Toggle panels: ⌘⌥S = left, ⌘⌥D = detail
      if ((e.metaKey || e.ctrlKey) && e.altKey && (e.key === 's' || e.key === 'S')) {
        setLeftHidden(v => !v); e.preventDefault();
      }
      if ((e.metaKey || e.ctrlKey) && e.altKey && (e.key === 'd' || e.key === 'D')) {
        setDetailHidden(v => !v); e.preventDefault();
      }
      if (['1','2','3','4','5'].includes(e.key) && activeId) {
        setRatings(p => ({ ...p, [activeId]: Number(e.key) }));
      }
      if (e.key === '0' && activeId) setRatings(p => ({ ...p, [activeId]: 0 }));
      if (e.key === 'p' && activeId) setFlags(p => ({ ...p, [activeId]: (flags[activeId] === 'pick' ? 'none' : 'pick') }));
      if (e.key === 'x' && activeId) setFlags(p => ({ ...p, [activeId]: (flags[activeId] === 'reject' ? 'none' : 'reject') }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, activeId, flags]);

  const images = MapleImages;
  const activeImg = images.find(i => i.id === activeId);

  // Filter application
  const filtered = React.useMemo(() => {
    let list = images;
    if (filter === 'picks') list = list.filter(i => (flags[i.id] || i.flag) === 'pick');
    if (filter === '4stars') list = list.filter(i => (ratings[i.id] ?? i.stars) >= 4);
    if (sort === 'name') list = [...list].sort((a, b) => a.file.localeCompare(b.file));
    return list;
  }, [images, filter, sort, flags, ratings]);

  // Augment images with live ratings/flags.
  const withEdits = (img) => ({
    ...img,
    stars: ratings[img.id] ?? img.stars,
    flag: flags[img.id] ?? img.flag,
  });

  const advance = (dir) => {
    const idx = filtered.findIndex(i => i.id === activeId);
    if (idx === -1) return;
    const next = filtered[Math.max(0, Math.min(filtered.length - 1, idx + dir))];
    if (next) { setActiveId(next.id); setSelectedRaw([next.id]); }
  };

  const onSelect = (id, e) => {
    if (e?.metaKey || e?.ctrlKey) {
      setSelectedRaw(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
    } else if (e?.shiftKey && selected.length > 0) {
      const startIdx = filtered.findIndex(i => i.id === selected[selected.length - 1]);
      const endIdx   = filtered.findIndex(i => i.id === id);
      const [a, b] = [Math.min(startIdx, endIdx), Math.max(startIdx, endIdx)];
      setSelectedRaw(filtered.slice(a, b + 1).map(i => i.id));
    } else {
      setSelectedRaw([id]);
    }
    setActiveId(id);
  };

  const onOpen = (id) => { setActiveId(id); setSelectedRaw([id]); setMode('full'); };

  const selectedSet = new Set(selected);

  // Source label
  const sourceLabel = (() => {
    for (const sec of MapleTree) {
      for (const c of sec.children) {
        if (c.kind === 'folder') {
          if (c.id === source) return c.label;
          if (c.children) for (const gc of c.children) if (gc.id === source) return gc.label;
        } else if (c.id === source) return c.label;
      }
    }
    return 'France trip';
  })();

  // Derived tokens from tweaks (for variants)
  const tok = {
    ...MapleTokens,
    primary: tweaks.accent || MapleTokens.primary,
    primaryDim: tweaks.accentDim || MapleTokens.primaryDim,
    sidebar: tweaks.sidebarVariant === 'pure-black' ? '#0a0908'
           : tweaks.sidebarVariant === 'equal-surface' ? MapleTokens.surface
           : MapleTokens.sidebar,
    border: tweaks.borderContrast === 'high' ? '#5a554f'
          : tweaks.borderContrast === 'low'  ? '#38332e'
          : MapleTokens.border,
  };

  // Inject tokens globally so components pick them up via MapleTokens import
  // (we mutate in-place; cheap and avoids prop-drilling).
  React.useMemo(() => {
    Object.assign(MapleTokens, tok);
  }, [JSON.stringify(tweaks)]);

  const thumbSizeByDensity = tweaks.gridDensity === 'compact' ? 90 :
                             tweaks.gridDensity === 'large'   ? 200 : thumbSize;

  return (
    <div style={{
      width: '100vw', height: '100vh',
      background: '#0d0c0b',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24,
      boxSizing: 'border-box',
    }}>
      <WindowChrome title={mode === 'browse' ? `Library — ${sourceLabel}` : (activeImg?.file ?? '')}
        selectedCount={selected.length}
        leftHidden={leftHidden} toggleLeft={() => setLeftHidden(v => !v)}
        detailHidden={detailHidden} toggleDetail={() => setDetailHidden(v => !v)}
        mode={mode}
        activeImg={activeImg}
        onBack={() => setMode('browse')}
        zoom={zoom} setZoom={setZoom}
        showBA={showBA} setShowBA={setShowBA}
        flag={activeImg ? (flags[activeId] ?? activeImg.flag) : 'none'}
        setFlag={(v) => setFlags(p => ({ ...p, [activeId]: v }))}
        rating={activeImg ? (ratings[activeId] ?? activeImg.stars) : 0}
        setRating={(v) => setRatings(p => ({ ...p, [activeId]: v }))}>
        <div style={{
          flex: 1, display: 'flex', minHeight: 0, minWidth: 0,
          background: tok.bg,
        }}>
          {/* Left panel: tree (browse) or filmstrip (full) */}
          <div style={{
            width: leftHidden ? 0 : (mode === 'browse' ? 220 : 80),
            flexShrink: 0,
            transition: `width 220ms ${MapleTokens.ease}`,
            position: 'relative', overflow: 'hidden',
          }}>
            <div style={{
              position: 'absolute', inset: 0,
              opacity: mode === 'browse' && !leftHidden ? 1 : 0,
              transition: `opacity 180ms ${MapleTokens.ease}`,
              pointerEvents: mode === 'browse' && !leftHidden ? 'auto' : 'none',
            }}>
              <MapleFileTree selectedId={source} onSelect={setSource}/>
            </div>
            <div style={{
              position: 'absolute', inset: 0,
              opacity: mode === 'full' && !leftHidden ? 1 : 0,
              transition: `opacity 180ms ${MapleTokens.ease}`,
              pointerEvents: mode === 'full' && !leftHidden ? 'auto' : 'none',
            }}>
              <MapleFilmstrip images={filtered.map(withEdits)}
                activeId={activeId}
                onSelect={(id) => { setActiveId(id); setSelectedRaw([id]); }}/>
            </div>
          </div>

          {/* Center panel */}
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            minWidth: 0, position: 'relative',
          }}>
            {mode === 'browse' ? (
              <>
                <GridToolbar
                  breadcrumb={['Local files', '2026', sourceLabel]}
                  thumbSize={thumbSizeByDensity}
                  setThumbSize={setThumbSize}
                  sort={sort} setSort={setSort}
                  filter={filter} setFilter={setFilter}
                  selectedCount={selected.length}
                  total={filtered.length}
                />
                <MapleGrid
                  images={filtered.map(withEdits)}
                  selectedIds={selectedSet}
                  onSelect={onSelect}
                  onOpen={onOpen}
                  thumbSize={thumbSizeByDensity}
                />
              </>
            ) : (
              activeImg && (
                <MapleFullImage
                  image={activeImg}
                  zoom={zoom} setZoom={setZoom}
                  showBeforeAfter={showBA} setShowBeforeAfter={setShowBA}
                />
              )
            )}
          </div>

          {/* Right panel — detail */}
          <div style={{
            width: detailHidden ? 0 : 280,
            flexShrink: 0,
            display: 'flex', flexDirection: 'column',
            background: tok.surface,
            minHeight: 0,
            overflow: 'hidden',
            transition: `width 220ms ${MapleTokens.ease}`,
            borderLeft: detailHidden ? 'none' : `0.5px solid ${tok.border}`,
          }}>
            <div style={{ width: 280, flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              {tab === 'info'    && <InfoTab   image={activeImg ? withEdits(activeImg) : null}
                                              flag={activeImg ? (flags[activeId] ?? activeImg.flag) : 'none'}
                                              setFlag={(v) => setFlags(p => ({ ...p, [activeId]: v }))}
                                              rating={activeImg ? (ratings[activeId] ?? activeImg.stars) : 0}
                                              setRating={(v) => setRatings(p => ({ ...p, [activeId]: v }))}
                                              colorLabel={colorLabels[activeId] ?? null}
                                              setColorLabel={(v) => setColorLabels(p => ({ ...p, [activeId]: v }))}/>}
              {tab === 'develop' && <ColorTab  image={activeImg} adj={adj} setAdj={setAdj} mode={mode}/>}
              <TabBar active={tab} setActive={setTab} mode={mode}/>
            </div>
          </div>
        </div>

        {tweaksOpen && <TweaksPanel tweaks={tweaks} setTweaks={setTweaks} onClose={() => {
          setTweaksOpen(false);
          window.parent.postMessage({ type: '__edit_mode_set_keys', edits: tweaks }, '*');
        }}/>}
      </WindowChrome>
    </div>
  );
}

function WindowChrome({ title, selectedCount, children, leftHidden, toggleLeft, detailHidden, toggleDetail, mode,
                         activeImg, onBack, zoom, setZoom, showBA, setShowBA, flag, setFlag, rating, setRating }) {
  const [hoverTL, setHoverTL] = React.useState(false);
  const [minimized, setMinimized] = React.useState(false);
  const [closed, setClosed] = React.useState(false);
  const [fs, setFs] = React.useState(false);

  const tl = (bg, symbol) => (
    <div style={{
      width: 12, height: 12, borderRadius: '50%', background: bg,
      border: '0.5px solid rgba(0,0,0,0.18)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer',
      fontFamily: MapleFont,
      fontSize: 8, fontWeight: 700,
      color: 'rgba(0,0,0,0.55)',
    }}>{hoverTL ? symbol : ''}</div>
  );

  if (closed) {
    // "Closed" sheet — tiny reopen card so the demo isn't a dead end.
    return (
      <div style={{
        width: 280, padding: 18, borderRadius: 10,
        background: MapleTokens.surface,
        border: `0.5px solid ${MapleTokens.border}`,
        boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
        color: MapleTokens.textMain,
        fontFamily: MapleFont, fontSize: 13, textAlign: 'center',
      }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Coral Maple</div>
        <div style={{ color: MapleTokens.textMuted, fontSize: 11, marginBottom: 14 }}>The window was closed.</div>
        <div onClick={() => setClosed(false)} style={{
          padding: '6px 12px', display: 'inline-block',
          borderRadius: 6, background: MapleTokens.primaryDim, color: MapleTokens.primary,
          border: `0.5px solid ${MapleTokens.primary}`,
          cursor: 'pointer', fontSize: 11,
        }}>Reopen</div>
      </div>
    );
  }

  const wrapStyle = {
    width: fs ? '100%' : '100%', height: fs ? '100%' : '100%',
    maxWidth: fs ? 'none' : 1500, maxHeight: fs ? 'none' : 1000,
    background: MapleTokens.bg,
    borderRadius: fs ? 0 : 12,
    overflow: 'hidden',
    display: 'flex', flexDirection: 'column',
    boxShadow: fs ? 'none' : '0 24px 80px rgba(0,0,0,0.5), 0 0 0 0.5px rgba(255,255,255,0.06)',
    fontFamily: MapleFont,
    position: 'relative',
    transform: minimized ? 'scale(0.08) translateY(440vh)' : 'scale(1)',
    transformOrigin: '50% 100%',
    transition: 'transform 360ms cubic-bezier(0.4, 0, 0.2, 1)',
    opacity: minimized ? 0 : 1,
  };

  return (
    <>
      <div style={wrapStyle}>
        {/* Titlebar integrated with app toolbar */}
        <div style={{
          height: 40,
          display: 'flex', alignItems: 'center',
          background: MapleTokens.surface,
          borderBottom: `0.5px solid ${MapleTokens.border}`,
          padding: '0 12px',
          flexShrink: 0,
          gap: 10,
        }}>
          {/* Traffic lights — functional macOS controls */}
          <div
            onMouseEnter={() => setHoverTL(true)}
            onMouseLeave={() => setHoverTL(false)}
            style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div onClick={() => setClosed(true)} title="Close">{tl('#ff5f56', '×')}</div>
            <div onClick={() => { setMinimized(true); setTimeout(() => setMinimized(false), 1200); }} title="Minimize">{tl('#ffbd2e', '–')}</div>
            <div onClick={() => setFs(v => !v)} title={fs ? 'Exit full screen' : 'Full screen'}>{tl('#27c93f', fs ? '⤢' : '⤢')}</div>
          </div>

          {/* Left: sidebar toggle — Apple-style */}
          <ChromeBtn active={!leftHidden} onClick={toggleLeft}
            title={`${leftHidden ? 'Show' : 'Hide'} sidebar  ⌥⌘S`}>
            <MapleIcon name={mode === 'full' ? 'filmstrip' : 'sidebar'} size={13}
              color={leftHidden ? MapleTokens.textMuted : MapleTokens.textMain}/>
          </ChromeBtn>

          {mode === 'full' ? (
            <ChromeBtn onClick={onBack} title="Back to library (Esc)">
              <MapleIcon name="back" size={12} color={MapleTokens.textMain}/>
            </ChromeBtn>
          ) : (
            <ChromeBtn title="Search">
              <MapleIcon name="search" size={12} color={MapleTokens.textMuted}/>
            </ChromeBtn>
          )}

          {mode === 'full' && activeImg ? (
            <div style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              minWidth: 0,
            }}>
              <div style={{
                fontFamily: MapleFont, fontSize: 12, fontWeight: 500,
                color: MapleTokens.textMain, marginRight: 6,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                maxWidth: 180,
              }}>{title}</div>

              <div style={{ width: 0.5, height: 18, background: MapleTokens.border }}/>

              {/* Zoom */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <IconButton onClick={() => setZoom(Math.max(1, zoom - 0.25))}>
                  <MapleIcon name="zoom-out" size={12}/>
                </IconButton>
                <div style={{
                  minWidth: 40, textAlign: 'center',
                  fontFamily: MapleMono, fontSize: 11, color: MapleTokens.textMain,
                  fontVariantNumeric: 'tabular-nums',
                }}>{zoom === 1 ? 'Fit' : `${Math.round(zoom * 100)}%`}</div>
                <IconButton onClick={() => setZoom(Math.min(4, zoom + 0.25))}>
                  <MapleIcon name="zoom-in" size={12}/>
                </IconButton>
              </div>

              <IconButton active={showBA} onClick={() => setShowBA(!showBA)}>
                <MapleIcon name="split" size={12}/>
                <span>Before/After</span>
              </IconButton>

              <div style={{ width: 0.5, height: 18, background: MapleTokens.border }}/>

              <FlagPills flag={flag} setFlag={setFlag}/>

              <div style={{ width: 0.5, height: 18, background: MapleTokens.border }}/>

              <div style={{ display: 'flex', gap: 1 }}>
                {[1,2,3,4,5].map(i => (
                  <div key={i} onClick={() => setRating(rating === i ? 0 : i)}
                    style={{ cursor: 'pointer', padding: 2 }}>
                    <MapleIcon name={i <= rating ? 'star-filled' : 'star'}
                      size={13}
                      color={i <= rating ? MapleTokens.star : MapleTokens.border}/>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{
              flex: 1, textAlign: 'center',
              fontFamily: MapleFont, fontSize: 12, fontWeight: 500,
              color: MapleTokens.textMain,
              letterSpacing: 0.1,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{title}</div>
          )}

          {/* Export button */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '4px 10px', borderRadius: 5,
            background: selectedCount > 0 ? MapleTokens.primaryDim : MapleTokens.inputBg,
            color: selectedCount > 0 ? MapleTokens.primary : MapleTokens.textMuted,
            border: `0.5px solid ${selectedCount > 0 ? MapleTokens.primary : MapleTokens.border}`,
            fontFamily: MapleFont, fontSize: 11,
            cursor: selectedCount > 0 ? 'pointer' : 'default',
            opacity: selectedCount > 0 ? 1 : 0.5,
          }}>
            <MapleIcon name="export" size={11}/>
            <span>Export{selectedCount > 1 ? ` (${selectedCount})` : ''}</span>
          </div>

          {/* Right: detail-panel toggle */}
          <ChromeBtn active={!detailHidden} onClick={toggleDetail}
            title={`${detailHidden ? 'Show' : 'Hide'} inspector  ⌥⌘D`}>
            <MapleIcon name="inspector" size={13}
              color={detailHidden ? MapleTokens.textMuted : MapleTokens.textMain}/>
          </ChromeBtn>
        </div>
        {children}
      </div>
    </>
  );
}

function ChromeBtn({ active = true, onClick, children, title }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      style={{
        width: 28, height: 24, borderRadius: 5,
        background: hover ? MapleTokens.surfaceHover
                   : active ? 'rgba(255,255,255,0.04)'
                            : 'transparent',
        border: `0.5px solid ${active && !hover ? MapleTokens.border : hover ? MapleTokens.border : 'transparent'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer',
        transition: 'background 120ms',
      }}>{children}</div>
  );
}

function TweaksPanel({ tweaks, setTweaks, onClose }) {
  const upd = (k, v) => setTweaks(p => ({ ...p, [k]: v }));
  const Section = ({ title, children }) => (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        fontFamily: MapleFont, fontSize: 10, fontWeight: 600,
        color: MapleTokens.textMuted, letterSpacing: '0.08em',
        textTransform: 'uppercase', marginBottom: 6,
      }}>{title}</div>
      {children}
    </div>
  );
  const Swatch = ({ c, selected, onClick }) => (
    <div onClick={onClick} style={{
      width: 22, height: 22, borderRadius: 4, background: c,
      cursor: 'pointer',
      outline: selected ? `1.5px solid ${MapleTokens.textMain}` : 'none',
      outlineOffset: 2,
    }}/>
  );
  const Opt = ({ selected, onClick, children }) => (
    <div onClick={onClick} style={{
      padding: '4px 8px', borderRadius: 3,
      fontFamily: MapleFont, fontSize: 11,
      background: selected ? MapleTokens.primaryDim : MapleTokens.inputBg,
      color: selected ? MapleTokens.primary : MapleTokens.textMain,
      border: `0.5px solid ${selected ? MapleTokens.primary : MapleTokens.border}`,
      cursor: 'pointer',
      textAlign: 'center', flex: 1,
    }}>{children}</div>
  );
  const accents = [
    ['#c4493a', '#422016'], // Maple
    ['#d97757', '#3b1d14'], // Clay
    ['#c9a14a', '#3a2e12'], // Gold
    ['#4ade80', '#14321f'], // Green
    ['#6aa0d4', '#152637'], // Blue
    ['#a58bd4', '#261b3a'], // Violet
  ];
  return (
    <div style={{
      position: 'absolute', right: 16, bottom: 16,
      width: 260,
      background: MapleTokens.surface,
      border: `0.5px solid ${MapleTokens.border}`,
      borderRadius: 8,
      padding: 14,
      boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
      zIndex: 100,
    }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 12,
      }}>
        <div style={{ fontFamily: MapleFont, fontSize: 12, fontWeight: 600, color: MapleTokens.textMain }}>Tweaks</div>
        <div onClick={onClose} style={{ cursor: 'pointer', color: MapleTokens.textMuted }}>
          <MapleIcon name="x" size={12}/>
        </div>
      </div>

      <Section title="Accent">
        <div style={{ display: 'flex', gap: 6 }}>
          {accents.map(([c, d]) => (
            <Swatch key={c} c={c} selected={tweaks.accent === c}
              onClick={() => setTweaks(p => ({ ...p, accent: c, accentDim: d }))}/>
          ))}
        </div>
      </Section>

      <Section title="Sidebar">
        <div style={{ display: 'flex', gap: 4 }}>
          <Opt selected={tweaks.sidebarVariant === 'warm-charcoal'} onClick={() => upd('sidebarVariant', 'warm-charcoal')}>Warm</Opt>
          <Opt selected={tweaks.sidebarVariant === 'pure-black'}    onClick={() => upd('sidebarVariant', 'pure-black')}>Black</Opt>
          <Opt selected={tweaks.sidebarVariant === 'equal-surface'} onClick={() => upd('sidebarVariant', 'equal-surface')}>Flat</Opt>
        </div>
      </Section>

      <Section title="Grid density">
        <div style={{ display: 'flex', gap: 4 }}>
          <Opt selected={tweaks.gridDensity === 'compact'} onClick={() => upd('gridDensity', 'compact')}>Compact</Opt>
          <Opt selected={tweaks.gridDensity === 'medium'}  onClick={() => upd('gridDensity', 'medium')}>Medium</Opt>
          <Opt selected={tweaks.gridDensity === 'large'}   onClick={() => upd('gridDensity', 'large')}>Large</Opt>
        </div>
      </Section>

      <Section title="Border contrast">
        <div style={{ display: 'flex', gap: 4 }}>
          <Opt selected={tweaks.borderContrast === 'low'}    onClick={() => upd('borderContrast', 'low')}>Low</Opt>
          <Opt selected={tweaks.borderContrast === 'normal'} onClick={() => upd('borderContrast', 'normal')}>Normal</Opt>
          <Opt selected={tweaks.borderContrast === 'high'}   onClick={() => upd('borderContrast', 'high')}>High</Opt>
        </div>
      </Section>

      <div style={{
        fontFamily: MapleFont, fontSize: 10, color: MapleTokens.textMuted,
        lineHeight: 1.5, marginTop: 4,
      }}>
        <div>Tips:</div>
        <div>• Double-click a thumbnail to open</div>
        <div>• Press 1–5 to rate · P pick · X reject</div>
        <div>• ← → to navigate · Esc to close</div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
