// Left panel in Browse mode — collapsible sections with folders/albums.

function TreeRow({ children, selected, level = 0, onClick, style = {} }) {
  const [hover, setHover] = React.useState(false);
  const bg = selected ? MapleTokens.primaryDim
          : hover    ? MapleTokens.bgHover
                     : 'transparent';
  const color = selected ? MapleTokens.primary : MapleTokens.textMain;
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        height: 26, padding: `0 10px 0 ${8 + level * 14}px`,
        margin: '0 6px', borderRadius: 5,
        fontFamily: MapleFont, fontSize: 12, fontWeight: selected ? 500 : 400,
        color, background: bg, cursor: 'pointer',
        transition: 'background 120ms', ...style,
      }}
    >{children}</div>
  );
}

function TreeSection({ node, expanded, onToggle, children }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div style={{ marginTop: 6 }}>
      <div
        onClick={onToggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex', alignItems: 'center', gap: 4,
          padding: '4px 10px 4px 8px', margin: '0 6px',
          borderRadius: 5, cursor: 'pointer',
          background: hover ? MapleTokens.bgHover : 'transparent',
        }}
      >
        <MapleIcon name={expanded ? 'chevron-down' : 'chevron-right'}
          size={10} color={MapleTokens.textMuted} strokeWidth={2}/>
        <span style={{
          fontFamily: MapleFont, fontSize: 10, fontWeight: 600,
          color: MapleTokens.textMuted, letterSpacing: '0.06em',
          textTransform: 'uppercase', flex: 1,
        }}>{node.label}</span>
        {hover && <MapleIcon name="plus" size={11} color={MapleTokens.textMuted}/>}
      </div>
      {expanded && <div style={{ marginTop: 2 }}>{children}</div>}
    </div>
  );
}

function FolderNode({ node, level, selectedId, onSelect, openMap, setOpen }) {
  const hasChildren = node.children && node.children.length;
  const isOpen = !!openMap[node.id] || node.open;
  return (
    <>
      <TreeRow
        level={level}
        selected={selectedId === node.id}
        onClick={() => onSelect(node.id)}
      >
        {hasChildren ? (
          <div
            onClick={(e) => { e.stopPropagation(); setOpen(node.id, !isOpen); }}
            style={{ display: 'flex', width: 12, justifyContent: 'center' }}
          >
            <MapleIcon name={isOpen ? 'chevron-down' : 'chevron-right'}
              size={10} color={MapleTokens.textMuted} strokeWidth={2}/>
          </div>
        ) : <div style={{ width: 12 }}/>}
        <MapleIcon name={isOpen && hasChildren ? 'folder-open' : 'folder'}
          size={13} color={selectedId === node.id ? MapleTokens.primary : MapleTokens.textMuted}/>
        <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {node.label}
        </span>
        {node.count != null && (
          <span style={{
            fontFamily: MapleMono, fontSize: 10, color: MapleTokens.textMuted,
            fontVariantNumeric: 'tabular-nums',
          }}>{node.count}</span>
        )}
      </TreeRow>
      {isOpen && hasChildren && node.children.map(c => (
        <FolderNode key={c.id} node={c} level={level + 1}
          selectedId={selectedId} onSelect={onSelect}
          openMap={openMap} setOpen={setOpen}/>
      ))}
    </>
  );
}

function MapleFileTree({ selectedId, onSelect }) {
  const [sections, setSections] = React.useState({ folders: true, photos: true });
  const [openMap, setOpenMap] = React.useState({ 'f-2026': true });
  const setOpen = (id, v) => setOpenMap(prev => ({ ...prev, [id]: v }));

  const iconFor = (icon) => ({
    photos: 'photos', heart: 'heart', check: 'check', x: 'x',
  })[icon] || 'dot';

  return (
    <div style={{
      width: '100%', height: '100%',
      background: MapleTokens.sidebar,
      overflowY: 'auto',
      borderRight: `0.5px solid ${MapleTokens.border}`,
      paddingBottom: 12,
    }}>
      {MapleTree.map(section => (
        <TreeSection
          key={section.id}
          node={section}
          expanded={sections[section.id]}
          onToggle={() => setSections(p => ({ ...p, [section.id]: !p[section.id] }))}
        >
          {section.id === 'folders' && section.children.length === 0 && (
            <div style={{ padding: '6px 18px', fontFamily: MapleFont, fontSize: 11, color: MapleTokens.textMuted }}>
              No local folders. <span style={{ color: MapleTokens.primary, cursor: 'pointer' }}>Add one</span>
            </div>
          )}
          {section.children.map(child => {
            if (child.kind === 'subheader') {
              return (
                <div key={child.label} style={{
                  fontFamily: MapleFont, fontSize: 10, fontWeight: 600,
                  color: MapleTokens.textMuted, letterSpacing: '0.06em',
                  textTransform: 'uppercase', padding: '10px 18px 4px',
                }}>{child.label}</div>
              );
            }
            if (child.kind === 'folder') {
              return <FolderNode key={child.id} node={child} level={1}
                selectedId={selectedId} onSelect={onSelect}
                openMap={openMap} setOpen={setOpen}/>;
            }
            // smart / album
            return (
              <TreeRow
                key={child.id}
                level={1}
                selected={selectedId === child.id}
                onClick={() => onSelect(child.id)}
              >
                <div style={{ width: 12 }}/>
                <MapleIcon name={child.kind === 'smart' ? iconFor(child.icon) : 'tag'}
                  size={13}
                  color={selectedId === child.id ? MapleTokens.primary : MapleTokens.textMuted}/>
                <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {child.label}
                </span>
                {child.count != null && (
                  <span style={{
                    fontFamily: MapleMono, fontSize: 10, color: MapleTokens.textMuted,
                    fontVariantNumeric: 'tabular-nums',
                  }}>{child.count.toLocaleString()}</span>
                )}
              </TreeRow>
            );
          })}
        </TreeSection>
      ))}
    </div>
  );
}

// Vertical filmstrip for Full-image mode.
function MapleFilmstrip({ images, activeId, onSelect }) {
  const refs = React.useRef({});
  React.useEffect(() => {
    const el = refs.current[activeId];
    if (el && el.scrollIntoView) {
      // Manual scroll within the container to avoid scrolling the page.
      const container = el.parentElement;
      const top = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
      container.scrollTo({ top, behavior: 'smooth' });
    }
  }, [activeId]);

  return (
    <div style={{
      width: '100%', height: '100%',
      background: MapleTokens.sidebar,
      overflowY: 'auto',
      borderRight: `0.5px solid ${MapleTokens.border}`,
      padding: '8px 14px',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      {images.map(img => {
        const active = img.id === activeId;
        return (
          <div
            key={img.id}
            ref={el => refs.current[img.id] = el}
            onClick={() => onSelect(img.id)}
            style={{
              width: 52, height: 40,
              background: `url("${img.thumb}") center/cover`,
              borderRadius: 2, cursor: 'pointer', flexShrink: 0,
              outline: active ? `1.5px solid ${MapleTokens.primary}` : 'none',
              outlineOffset: -1.5,
              position: 'relative',
            }}
          >
            {img.edited && (
              <div style={{
                position: 'absolute', top: 2, right: 2,
                width: 7, height: 7, borderRadius: '50%',
                background: MapleTokens.successText,
              }}/>
            )}
          </div>
        );
      })}
    </div>
  );
}

Object.assign(window, { MapleFileTree, MapleFilmstrip });
