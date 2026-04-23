// Right panel — detail with 2 tabs: Info (info + meta) / Develop (color + scopes)

function TabBar({ active, setActive, mode }) {
  const tabs = [
    { id: 'info',    label: 'Info',    icon: 'info' },
    { id: 'develop', label: 'Develop', icon: 'droplet' },
  ];
  return (
    <div style={{
      display: 'flex', height: 40, flexShrink: 0,
      borderTop: `0.5px solid ${MapleTokens.border}`,
      background: MapleTokens.surfaceAlt,
    }}>
      {tabs.map(t => {
        const isActive = active === t.id;
        const disabled = t.disabled;
        return (
          <div
            key={t.id}
            onClick={() => !disabled && setActive(t.id)}
            style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 4, cursor: disabled ? 'default' : 'pointer',
              fontFamily: MapleFont, fontSize: 10, fontWeight: 500,
              color: disabled ? `${MapleTokens.textMuted}80`
                   : isActive ? MapleTokens.primary
                              : MapleTokens.textMuted,
              background: isActive ? MapleTokens.surface : 'transparent',
              borderTop: isActive ? `2px solid ${MapleTokens.primary}` : '2px solid transparent',
              letterSpacing: 0.3,
              textTransform: 'uppercase',
            }}
          >
            <MapleIcon name={t.icon} size={12}
              color={disabled ? `${MapleTokens.textMuted}80`
                    : isActive ? MapleTokens.primary
                               : MapleTokens.textMuted}/>
            <span>{t.label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Info tab (merged: file info + camera + rating/flags + location + dates + IPTC + sidecar + history) ──
function InfoTab({ image, flag, setFlag, rating, setRating, colorLabel, setColorLabel }) {
  if (!image) return <EmptyDetail label="Select an image to see details"/>;
  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <MapleCollapsible label="File" storageKey="info-file">
        <KV k="Name" v={image.file}/>
        <KV k="Format" v={`Canon RAW · ${image.file.split('.').pop()}`}/>
        <KV k="Dimensions" v={`${image.w} × ${image.h}`}/>
        <KV k="Size" v="42.8 MB"/>
        {image.edited && (
          <div style={{ padding: '6px 14px 2px' }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '3px 7px', borderRadius: 3,
              background: MapleTokens.successBg,
              color: MapleTokens.successText,
              fontFamily: MapleFont, fontSize: 10, fontWeight: 500,
            }}>
              <MapleIcon name="check" size={10} strokeWidth={2.5}/>
              <span>{image.file.replace(/\.[^.]+$/, '.xmp')}</span>
            </div>
          </div>
        )}
      </MapleCollapsible>

      <MapleCollapsible label="Camera" storageKey="info-camera">
        <KV k="Body" v={image.cam}/>
        <KV k="Lens" v={image.lens}/>
        <KV k="Focal" v={image.mm}/>
        <KV k="Aperture" v={image.ap}/>
        <KV k="Shutter" v={image.ss}/>
        <KV k="ISO" v={image.iso.toString()}/>
        <KV k="Flash" v="Not fired"/>
      </MapleCollapsible>

      <MapleCollapsible label="Rating & flags" storageKey="info-rating">
        <div style={{ padding: '2px 14px 8px' }}>
          <FlagPills flag={flag} setFlag={setFlag}/>
        </div>
        <div style={{ padding: '0 14px 8px', display: 'flex', gap: 2 }}>
          {[1,2,3,4,5].map(i => (
            <div key={i} onClick={() => setRating(rating === i ? 0 : i)}
              style={{ cursor: 'pointer', padding: 2 }}>
              <MapleIcon name={i <= rating ? 'star-filled' : 'star'}
                size={15}
                color={i <= rating ? MapleTokens.star : MapleTokens.border}/>
            </div>
          ))}
        </div>
        <div style={{ padding: '0 14px 4px' }}>
          <div style={{ fontFamily: MapleFont, fontSize: 10, color: MapleTokens.textMuted, marginBottom: 6, letterSpacing: 0.3, textTransform: 'uppercase' }}>Color label</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[
              ['red', '#e74c3c'],
              ['orange', '#e9873f'],
              ['yellow', '#e9b93f'],
              ['green', '#4ade80'],
              ['blue', '#6aa0d4'],
            ].map(([name, c]) => (
              <div key={name}
                onClick={() => setColorLabel(colorLabel === name ? null : name)}
                style={{
                  width: 16, height: 16, borderRadius: '50%',
                  background: c, cursor: 'pointer',
                  outline: colorLabel === name ? `1.5px solid ${MapleTokens.textMain}` : 'none',
                  outlineOffset: 2,
                }}
                title={name}/>
            ))}
          </div>
        </div>
      </MapleCollapsible>

      <MapleCollapsible label="Location" storageKey="info-location">
        <KV k="Coords" v={`${image.gps.lat.toFixed(4)}, ${image.gps.lon.toFixed(4)}`}/>
        <KV k="City"   v={`${image.city}, ${image.region}`}/>
        <KV k="Country" v={image.country}/>
        <div style={{ padding: '6px 14px 2px' }}>
          <div style={{
            height: 86, borderRadius: 4, border: `0.5px solid ${MapleTokens.border}`,
            background: `
              radial-gradient(circle at 42% 62%, rgba(196,73,58,0.8) 0, rgba(196,73,58,0) 6px),
              linear-gradient(135deg, #22302a 0%, #1a201d 100%)
            `,
            position: 'relative', cursor: 'pointer',
          }}>
            <div style={{
              position: 'absolute', inset: 0, opacity: 0.35,
              backgroundImage: `
                linear-gradient(90deg, rgba(168,162,158,0.2) 1px, transparent 1px),
                linear-gradient(0deg, rgba(168,162,158,0.15) 1px, transparent 1px)
              `,
              backgroundSize: '16px 16px',
            }}/>
            <div style={{
              position: 'absolute', left: '42%', top: '62%',
              width: 8, height: 8, borderRadius: '50%',
              background: MapleTokens.primary,
              transform: 'translate(-50%, -50%)',
              boxShadow: '0 0 0 3px rgba(196,73,58,0.25)',
            }}/>
            <div style={{
              position: 'absolute', left: 8, bottom: 6,
              fontFamily: MapleMono, fontSize: 9, color: MapleTokens.textMuted,
            }}>Open in Maps ›</div>
          </div>
        </div>
      </MapleCollapsible>

      <MapleCollapsible label="Dates" storageKey="info-dates" defaultOpen={false}>
        <KV k="Captured" v={image.date}/>
        <KV k="Modified" v="2026-04-18 21:04"/>
        <KV k="Created"  v={image.date}/>
      </MapleCollapsible>

      <MapleCollapsible label="IPTC" storageKey="info-iptc" defaultOpen={false}>
        <EditableRow label="Title"     defaultValue={image.title}/>
        <EditableRow label="Caption"   defaultValue=""/>
        <EditableRow label="Copyright" defaultValue="© 2026 Z. Lawrence"/>
        <EditableRow label="Creator"   defaultValue="Z. Lawrence"/>
        <div style={{ padding: '6px 14px 2px' }}>
          <div style={{ fontFamily: MapleFont, fontSize: 10, color: MapleTokens.textMuted, marginBottom: 6, letterSpacing: 0.3, textTransform: 'uppercase' }}>Keywords</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {image.keywords.map(k => (
              <div key={k} style={{
                padding: '2px 6px', borderRadius: 3,
                background: MapleTokens.surfaceAlt,
                border: `0.5px solid ${MapleTokens.border}`,
                fontFamily: MapleFont, fontSize: 10,
                color: MapleTokens.textMain,
                display: 'flex', alignItems: 'center', gap: 3,
              }}>
                {k}
                <MapleIcon name="x" size={8} color={MapleTokens.textMuted}/>
              </div>
            ))}
            <div style={{
              padding: '2px 6px', borderRadius: 3,
              border: `0.5px dashed ${MapleTokens.border}`,
              fontFamily: MapleFont, fontSize: 10,
              color: MapleTokens.textMuted,
              cursor: 'pointer',
            }}>+ add</div>
          </div>
        </div>
      </MapleCollapsible>

      <MapleCollapsible label="Sidecar" storageKey="info-sidecar" defaultOpen={false}>
        <KV k="File"  v={image.file.replace(/\.[^.]+$/, '.xmp')}/>
        <KV k="Edits" v={image.edited ? '7 adjustments' : 'none'}/>
      </MapleCollapsible>

      <MapleCollapsible label="Edit history" storageKey="info-history" defaultOpen={false}>
        <div style={{ padding: '0 14px 4px' }}>
          {['Original import', 'Basic tone', 'Warm grade'].map((s, i) => (
            <div key={s} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 0',
              borderBottom: i < 2 ? `0.5px solid ${MapleTokens.border}` : 'none',
            }}>
              <MapleIcon name="history" size={11} color={MapleTokens.textMuted}/>
              <span style={{ flex: 1, fontFamily: MapleFont, fontSize: 11, color: MapleTokens.textMain }}>{s}</span>
              <span style={{ fontFamily: MapleMono, fontSize: 9, color: MapleTokens.textMuted }}>{i === 0 ? 'Import' : i === 1 ? '3d ago' : '2h ago'}</span>
            </div>
          ))}
          <div style={{ marginTop: 6 }}>
            <SmallBtn><MapleIcon name="plus" size={11}/><span>Add snapshot</span></SmallBtn>
          </div>
        </div>
      </MapleCollapsible>
    </div>
  );
}

function KV({ k, v }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', gap: 8,
      padding: '3px 14px',
    }}>
      <span style={{ fontFamily: MapleFont, fontSize: 11, color: MapleTokens.textMuted }}>{k}</span>
      <span style={{
        fontFamily: MapleMono, fontSize: 11, color: MapleTokens.textMain,
        textAlign: 'right', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '65%',
      }}>{v}</span>
    </div>
  );
}

function EmptyDetail({ label }) {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20, color: MapleTokens.textMuted,
      fontFamily: MapleFont, fontSize: 11, textAlign: 'center',
    }}>{label}</div>
  );
}

// ── Develop tab (color + live scopes) ──
function ColorTab({ image, adj, setAdj, mode }) {
  if (!image) return <EmptyDetail label="Select an image to edit"/>;
  const upd = (k, v) => setAdj(prev => ({ ...prev, [k]: v }));

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* Scopes live at the top of Develop — compact, always visible when in full mode */}
        <div style={{ padding: '0 14px' }}>
          <EmbeddedScopes image={image} adj={adj} mode={mode}/>
        </div>

        <MapleCollapsible label="Tone" storageKey="dev-tone">
          <div style={{ padding: '0 14px' }}>
            <MapleSlider label="Exposure"    value={adj.exposure}   min={-4} max={4} step={0.05} unit=" EV" onChange={v => upd('exposure', Number(v.toFixed(2)))}/>
            <MapleSlider label="Contrast"    value={adj.contrast}   min={-100} max={100} onChange={v => upd('contrast', v)}/>
            <MapleSlider label="Highlights"  value={adj.highlights} min={-100} max={100} onChange={v => upd('highlights', v)}/>
            <MapleSlider label="Shadows"     value={adj.shadows}    min={-100} max={100} onChange={v => upd('shadows', v)}/>
            <MapleSlider label="Whites"      value={adj.whites}     min={-100} max={100} onChange={v => upd('whites', v)}/>
            <MapleSlider label="Blacks"      value={adj.blacks}     min={-100} max={100} onChange={v => upd('blacks', v)}/>
          </div>
        </MapleCollapsible>

        <MapleCollapsible label="White balance" storageKey="dev-wb">
          <div style={{ padding: '0 14px' }}>
            <WbPresetRow value={adj.wbPreset} onChange={v => upd('wbPreset', v)}/>
            <MapleSlider label="Temperature" value={adj.temp} min={2000} max={12000} step={50} unit=" K" onChange={v => upd('temp', v)}/>
            <MapleSlider label="Tint" value={adj.tint} min={-100} max={100} onChange={v => upd('tint', v)}/>
            <div style={{ marginTop: 4 }}>
              <SmallBtn><MapleIcon name="eyedrop" size={11}/><span>Pick neutral</span></SmallBtn>
            </div>
          </div>
        </MapleCollapsible>

        <MapleCollapsible label="Presence" storageKey="dev-presence">
          <div style={{ padding: '0 14px' }}>
            <MapleSlider label="Clarity"    value={adj.clarity}    min={-100} max={100} onChange={v => upd('clarity', v)}/>
            <MapleSlider label="Texture"    value={adj.texture}    min={-100} max={100} onChange={v => upd('texture', v)}/>
            <MapleSlider label="Dehaze"     value={adj.dehaze}     min={-100} max={100} onChange={v => upd('dehaze', v)}/>
            <MapleSlider label="Vibrance"   value={adj.vibrance}   min={-100} max={100} onChange={v => upd('vibrance', v)}/>
            <MapleSlider label="Saturation" value={adj.saturation} min={-100} max={100} onChange={v => upd('saturation', v)}/>
          </div>
        </MapleCollapsible>

        <MapleCollapsible label="Sharpening" storageKey="dev-sharp" defaultOpen={false}>
          <div style={{ padding: '0 14px' }}>
            <MapleSlider label="Amount"  value={adj.sharpAmount} min={0} max={150} onChange={v => upd('sharpAmount', v)}/>
            <MapleSlider label="Radius"  value={adj.sharpRadius} min={0.5} max={3} step={0.1} onChange={v => upd('sharpRadius', Number(v.toFixed(1)))}/>
            <MapleSlider label="Detail"  value={adj.sharpDetail} min={0} max={100} onChange={v => upd('sharpDetail', v)}/>
            <MapleSlider label="Masking" value={adj.sharpMasking} min={0} max={100} onChange={v => upd('sharpMasking', v)}/>
          </div>
        </MapleCollapsible>

        <MapleCollapsible label="Noise reduction" storageKey="dev-noise" defaultOpen={false}>
          <div style={{ padding: '0 14px' }}>
            <MapleSlider label="Luminance" value={adj.noiseLum}   min={0} max={100} onChange={v => upd('noiseLum', v)}/>
            <MapleSlider label="Color"     value={adj.noiseColor} min={0} max={100} onChange={v => upd('noiseColor', v)}/>
          </div>
        </MapleCollapsible>

        <div style={{ height: 12 }}/>
      </div>

      {/* sticky action row */}
      <div style={{
        display: 'flex', gap: 4, padding: 8,
        borderTop: `0.5px solid ${MapleTokens.border}`,
        background: MapleTokens.surface,
      }}>
        <SmallBtn onClick={() => setAdj(DEFAULT_ADJ)}><MapleIcon name="revert" size={11}/><span>Revert</span></SmallBtn>
        <SmallBtn><MapleIcon name="copy" size={11}/><span>Copy</span></SmallBtn>
        <SmallBtn><MapleIcon name="paste" size={11}/><span>Paste</span></SmallBtn>
      </div>
    </div>
  );
}

function WbPresetRow({ value, onChange }) {
  const presets = ['Auto', 'Daylight', 'Cloudy', 'Shade', 'Tungsten', 'Flash', 'Custom'];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, margin: '4px 0 10px' }}>
      {presets.map(p => {
        const active = value === p;
        return (
          <div key={p} onClick={() => onChange(p)}
            style={{
              padding: '3px 7px', borderRadius: 3,
              fontFamily: MapleFont, fontSize: 10,
              background: active ? MapleTokens.primaryDim : MapleTokens.surfaceAlt,
              color: active ? MapleTokens.primary : MapleTokens.textMuted,
              border: `0.5px solid ${active ? MapleTokens.primary : MapleTokens.border}`,
              cursor: 'pointer',
            }}>{p}</div>
        );
      })}
    </div>
  );
}

function SmallBtn({ children, onClick }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
        height: 26, borderRadius: 4,
        background: hover ? MapleTokens.surfaceHover : MapleTokens.inputBg,
        border: `0.5px solid ${MapleTokens.border}`,
        color: MapleTokens.textMain,
        fontFamily: MapleFont, fontSize: 11,
        cursor: 'pointer', transition: 'background 120ms',
      }}>{children}</div>
  );
}

// ── Meta tab (now merged into InfoTab; this stub remains for back-compat but is unused) ──
function MetaTab({ image }) {
  return null;
}

function EditableRow({ label, defaultValue }) {
  const [value, setValue] = React.useState(defaultValue);
  const [focus, setFocus] = React.useState(false);
  return (
    <div style={{ padding: '3px 14px' }}>
      <div style={{ fontFamily: MapleFont, fontSize: 10, color: MapleTokens.textMuted, marginBottom: 2 }}>{label}</div>
      <input
        value={value}
        onChange={e => setValue(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        placeholder="—"
        style={{
          width: '100%', height: 24,
          background: MapleTokens.inputBg,
          border: `0.5px solid ${focus ? MapleTokens.primary : MapleTokens.border}`,
          borderRadius: 3,
          padding: '0 6px',
          fontFamily: MapleFont, fontSize: 11,
          color: MapleTokens.textMain,
          outline: 'none',
        }}
      />
    </div>
  );
}

// Default adjustment state for the Color tab.
const DEFAULT_ADJ = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
  wbPreset: 'Auto', temp: 5500, tint: 0,
  clarity: 0, texture: 0, dehaze: 0, vibrance: 0, saturation: 0,
  sharpAmount: 40, sharpRadius: 1.0, sharpDetail: 25, sharpMasking: 0,
  noiseLum: 0, noiseColor: 25,
};

Object.assign(window, { TabBar, InfoTab, ColorTab, MetaTab, DEFAULT_ADJ });
