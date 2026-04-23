// Scopes tab — draws histogram, waveform, parade, vectorscope on a canvas.
// Uses a deterministic fake distribution based on image id + adjustments so they
// respond live to slider changes.

function ScopesTab({ image, adj, mode }) {
  const [scopeType, setScopeType] = React.useState('histogram');
  const [channels, setChannels] = React.useState({ r: true, g: true, b: true });

  if (mode !== 'full') {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20, textAlign: 'center',
      }}>
        <div style={{
          fontFamily: MapleFont, fontSize: 11, color: MapleTokens.textMuted,
          lineHeight: 1.5,
        }}>
          <div style={{ marginBottom: 8 }}>
            <MapleIcon name="scope" size={24} color={MapleTokens.textMuted}/>
          </div>
          Open an image to view scopes
        </div>
      </div>
    );
  }
  if (!image) return <EmptyDetail label="Select an image to view scopes"/>;

  const scopes = ['histogram', 'waveform', 'parade', 'vectorscope'];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Segmented control */}
      <div style={{ padding: '12px 10px 8px' }}>
        <div style={{
          display: 'flex',
          background: MapleTokens.inputBg,
          border: `0.5px solid ${MapleTokens.border}`,
          borderRadius: 4,
          padding: 2,
        }}>
          {scopes.map(s => (
            <div key={s} onClick={() => setScopeType(s)}
              style={{
                flex: 1, textAlign: 'center',
                padding: '4px 0', borderRadius: 3,
                fontFamily: MapleFont, fontSize: 10,
                background: scopeType === s ? MapleTokens.surface : 'transparent',
                color: scopeType === s ? MapleTokens.textMain : MapleTokens.textMuted,
                cursor: 'pointer',
                textTransform: 'capitalize',
                border: scopeType === s ? `0.5px solid ${MapleTokens.border}` : '0.5px solid transparent',
              }}>{s}</div>
          ))}
        </div>
      </div>

      {/* Channel toggles for histogram */}
      {scopeType === 'histogram' && (
        <div style={{ padding: '0 14px 8px', display: 'flex', gap: 6 }}>
          {['r', 'g', 'b'].map(ch => {
            const color = ch === 'r' ? '#f87171' : ch === 'g' ? '#4ade80' : '#6aa0d4';
            const on = channels[ch];
            return (
              <div key={ch} onClick={() => setChannels(p => ({ ...p, [ch]: !p[ch] }))}
                style={{
                  padding: '2px 8px', borderRadius: 3,
                  background: on ? `${color}22` : MapleTokens.surfaceAlt,
                  color: on ? color : MapleTokens.textMuted,
                  fontFamily: MapleMono, fontSize: 10,
                  border: `0.5px solid ${on ? color : MapleTokens.border}`,
                  cursor: 'pointer', textTransform: 'uppercase', letterSpacing: 0.5,
                }}>{ch}</div>
            );
          })}
        </div>
      )}

      {/* Scope canvas */}
      <div style={{ padding: '0 10px 10px' }}>
        <ScopeCanvas
          type={scopeType}
          imageId={image.id}
          adj={adj}
          channels={channels}
        />
      </div>

      {/* Numeric readout */}
      <div style={{
        padding: '10px 14px', borderTop: `0.5px solid ${MapleTokens.border}`,
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px',
      }}>
        <KV k="Black pt" v={clamp(adj.blacks * 0.3 + 4, 0, 10).toFixed(1) + ' IRE'}/>
        <KV k="White pt" v={clamp(100 - adj.whites * 0.2, 90, 108).toFixed(1) + ' IRE'}/>
        <KV k="Mean L"   v={clamp(50 + adj.exposure * 6 + adj.contrast * 0.05, 0, 100).toFixed(1)}/>
        <KV k="Clip Hi"  v={Math.max(0, Math.round(adj.whites * 0.04 + adj.exposure * 1.5)) + '%'}/>
        <KV k="Clip Lo"  v={Math.max(0, Math.round(-adj.blacks * 0.04 - adj.exposure * 0.5)) + '%'}/>
        <KV k="WB"       v={`${adj.temp}K / ${adj.tint > 0 ? '+' : ''}${adj.tint}`}/>
      </div>
    </div>
  );
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// Canvas scope renderer. Uses a seeded PRNG so the same image always produces the
// same base shape; sliders deform it.
function ScopeCanvas({ type, imageId, adj, channels }) {
  const canvasRef = React.useRef(null);
  const [size, setSize] = React.useState({ w: 220, h: 160 });

  React.useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const w = Math.floor(e.contentRect.width);
        setSize(s => s.w === w ? s : { ...s, w });
      }
    });
    ro.observe(el.parentElement);
    return () => ro.disconnect();
  }, []);

  React.useEffect(() => {
    drawScope(canvasRef.current, type, imageId, adj, channels, size);
  }, [type, imageId, adj, channels, size]);

  return (
    <canvas
      ref={canvasRef}
      width={size.w * 2}
      height={size.h * 2}
      style={{
        width: '100%', height: size.h,
        background: MapleTokens.imageCanvas,
        borderRadius: 3,
        border: `0.5px solid ${MapleTokens.border}`,
      }}
    />
  );
}

// Seeded PRNG (mulberry32)
function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t |= 0; t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function drawScope(canvas, type, imageId, adj, channels, size) {
  if (!canvas) return;
  const dpr = 2;
  const W = size.w * dpr, H = size.h * dpr;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  if (type === 'histogram') drawHistogram(ctx, W, H, imageId, adj, channels);
  else if (type === 'waveform') drawWaveform(ctx, W, H, imageId, adj);
  else if (type === 'parade') drawParade(ctx, W, H, imageId, adj);
  else if (type === 'vectorscope') drawVectorscope(ctx, W, H, imageId, adj);
}

function buildHistogram(imageId, bands = 128) {
  // Base curve: sum of 3 gaussians at varying positions; image id picks the seed.
  const r = rng(imageId * 7919 + 1);
  const c1 = 0.2 + r() * 0.15, c2 = 0.45 + r() * 0.15, c3 = 0.7 + r() * 0.15;
  const w1 = 0.08, w2 = 0.1, w3 = 0.09;
  const out = new Array(bands).fill(0);
  for (let i = 0; i < bands; i++) {
    const x = i / bands;
    out[i] = 0.7 * Math.exp(-((x - c1) ** 2) / (2 * w1 * w1))
           + 0.8 * Math.exp(-((x - c2) ** 2) / (2 * w2 * w2))
           + 0.5 * Math.exp(-((x - c3) ** 2) / (2 * w3 * w3));
  }
  return out;
}

function applyTonal(hist, shift, contrast, expose) {
  const n = hist.length;
  const out = new Array(n).fill(0);
  const exposeShift = expose * 4; // exposure in bins
  for (let i = 0; i < n; i++) {
    // contrast around 0.5
    const x = (i + exposeShift + shift) / n;
    const cx = (x - 0.5) * (1 + contrast * 0.01) + 0.5;
    const j = Math.round(cx * n);
    if (j >= 0 && j < n) out[j] += hist[i];
  }
  return out;
}

function drawHistogram(ctx, W, H, imageId, adj, channels) {
  const pad = 8 * 2;
  const w = W - pad * 2, h = H - pad * 2;
  ctx.translate(pad, pad);

  // Grid
  ctx.strokeStyle = 'rgba(168,162,158,0.1)'; ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const x = (w * i / 4);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }

  const channelsList = [
    ['r', '#f87171', -2],
    ['g', '#4ade80',  0],
    ['b', '#6aa0d4', +2],
  ];

  const bands = 128;
  let maxVal = 0;
  const curves = channelsList.map(([ch, color, bias]) => {
    if (!channels[ch]) return null;
    let hist = buildHistogram(imageId + (ch === 'r' ? 7 : ch === 'g' ? 13 : 19));
    // tint shift via temp/tint
    const tempShift = (ch === 'r' ? (adj.temp - 5500) * 0.002 : ch === 'b' ? -(adj.temp - 5500) * 0.002 : 0);
    const tintShift = (ch === 'g' ? adj.tint * 0.05 : -adj.tint * 0.025);
    hist = applyTonal(hist, bias + tempShift + tintShift, adj.contrast + adj.clarity * 0.3, adj.exposure);
    // highlights/shadows
    const hi = adj.highlights * 0.005, lo = adj.shadows * 0.005;
    hist = hist.map((v, i) => {
      const x = i / bands;
      let mult = 1 + hi * (x - 0.6) + lo * (0.4 - x);
      return Math.max(0, v * Math.max(0, mult));
    });
    const m = Math.max(...hist);
    if (m > maxVal) maxVal = m;
    return { ch, color, hist };
  }).filter(Boolean);

  const scale = h / (maxVal * 1.1 || 1);
  ctx.globalCompositeOperation = 'screen';
  for (const { color, hist } of curves) {
    ctx.fillStyle = color + '80';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < bands; i++) {
      const x = (i / (bands - 1)) * w;
      const y = h - hist[i] * scale;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h); ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';

  // Clip markers
  const hiClip = Math.max(0, adj.whites * 0.04 + adj.exposure * 1.5);
  const loClip = Math.max(0, -adj.blacks * 0.04 - adj.exposure * 0.5);
  if (hiClip > 0) {
    ctx.fillStyle = '#f8717140';
    ctx.fillRect(w - 8, 0, 8, h);
  }
  if (loClip > 0) {
    ctx.fillStyle = '#6aa0d440';
    ctx.fillRect(0, 0, 8, h);
  }
}

function drawWaveform(ctx, W, H, imageId, adj) {
  const pad = 8 * 2;
  const w = W - pad * 2, h = H - pad * 2;
  ctx.translate(pad, pad);

  // IRE grid
  ctx.strokeStyle = 'rgba(168,162,158,0.15)'; ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  for (let v = 0; v <= 100; v += 25) {
    const y = h - (v / 100) * h;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.setLineDash([]);

  // Luma cloud — draw dots across x with varying luma column
  const cols = 140;
  const samplesPerCol = 80;
  const r = rng(imageId * 1234);
  ctx.fillStyle = 'rgba(231,229,228,0.15)';
  for (let c = 0; c < cols; c++) {
    const xNorm = c / cols;
    // Scene-specific luma shape: wavy
    const base = 0.35 + 0.25 * Math.sin(xNorm * Math.PI * 2 + r() * 2)
                      + 0.15 * Math.sin(xNorm * Math.PI * 5 + r());
    const x = xNorm * w;
    for (let s = 0; s < samplesPerCol; s++) {
      let lum = base + (r() - 0.5) * 0.3;
      // apply tone
      lum = (lum - 0.5) * (1 + adj.contrast * 0.01) + 0.5 + adj.exposure * 0.08;
      lum = lum + (lum > 0.6 ? adj.highlights * 0.002 : 0) + (lum < 0.4 ? adj.shadows * 0.002 : 0);
      lum = Math.max(0, Math.min(1, lum));
      const y = h - lum * h;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  // Y-axis labels
  ctx.fillStyle = MapleTokens.textMuted;
  ctx.font = '10px ' + MapleMono;
  for (let v = 0; v <= 100; v += 25) {
    const y = h - (v / 100) * h;
    ctx.fillText(String(v), 2, y - 2);
  }
}

function drawParade(ctx, W, H, imageId, adj) {
  const pad = 8 * 2;
  const w = W - pad * 2, h = H - pad * 2;
  const gutter = 4;
  const colW = (w - gutter * 2) / 3;
  ctx.translate(pad, pad);

  const channelsP = [
    { x: 0, color: '#f87171', seed: 7, biasT: (adj.temp - 5500) * 0.00005 },
    { x: colW + gutter, color: '#4ade80', seed: 13, biasT: 0 },
    { x: (colW + gutter) * 2, color: '#6aa0d4', seed: 19, biasT: -(adj.temp - 5500) * 0.00005 },
  ];

  // Grid
  ctx.strokeStyle = 'rgba(168,162,158,0.1)';
  for (let v = 0; v <= 100; v += 25) {
    const y = h - (v / 100) * h;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  for (const p of channelsP) {
    const cols = 70, samples = 60;
    const r = rng(imageId * p.seed);
    ctx.fillStyle = p.color + '33';
    for (let c = 0; c < cols; c++) {
      const xN = c / cols;
      const base = 0.4 + 0.25 * Math.sin(xN * Math.PI * 3 + r() * 2);
      const x = p.x + xN * colW;
      for (let s = 0; s < samples; s++) {
        let lum = base + (r() - 0.5) * 0.35 + p.biasT;
        lum = (lum - 0.5) * (1 + adj.contrast * 0.008) + 0.5 + adj.exposure * 0.08;
        lum = Math.max(0, Math.min(1, lum));
        const y = h - lum * h;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }

  // Channel labels
  ctx.fillStyle = MapleTokens.textMuted;
  ctx.font = 'bold 10px ' + MapleMono;
  ['R', 'G', 'B'].forEach((ch, i) => {
    const x = i * (colW + gutter) + colW / 2 - 4;
    ctx.fillText(ch, x, h - 4);
  });
}

function drawVectorscope(ctx, W, H, imageId, adj) {
  const cx = W / 2, cy = H / 2;
  const radius = Math.min(W, H) / 2 - 16;

  // Outer circle
  ctx.strokeStyle = 'rgba(168,162,158,0.2)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, radius * 0.6, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, radius * 0.3, 0, Math.PI * 2); ctx.stroke();

  // Color targets at the six primaries
  const targets = [
    { ang: 0,             color: '#f87171', label: 'R' },
    { ang: Math.PI/3,     color: '#e9b93f', label: 'Y' },
    { ang: 2*Math.PI/3,   color: '#4ade80', label: 'G' },
    { ang: Math.PI,       color: '#6aa0d4', label: 'C' },
    { ang: 4*Math.PI/3,   color: '#8a7fd4', label: 'B' },
    { ang: 5*Math.PI/3,   color: '#d47fb0', label: 'M' },
  ];
  ctx.font = 'bold 10px ' + MapleMono;
  for (const t of targets) {
    const x = cx + Math.cos(t.ang) * radius;
    const y = cy + Math.sin(t.ang) * radius;
    ctx.fillStyle = t.color;
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillText(t.label, x + 6, y + 4);
  }

  // Skin tone line (from center toward ~123°)
  const skinAng = Math.PI * (360 - 123) / 180;
  ctx.strokeStyle = '#e9b93f80';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(skinAng) * radius, cy + Math.sin(skinAng) * radius);
  ctx.stroke();
  ctx.setLineDash([]);

  // Data cloud
  const r = rng(imageId * 2017);
  const centerAng = (adj.temp - 5500) * 0.00002 + adj.tint * 0.004;
  const satScale = 0.35 + adj.saturation * 0.003 + adj.vibrance * 0.0015;
  for (let i = 0; i < 1200; i++) {
    const ang = r() * Math.PI * 2;
    const dist = Math.pow(r(), 1.4) * radius * Math.abs(satScale) + radius * 0.06;
    const x = cx + Math.cos(ang + centerAng) * dist;
    const y = cy + Math.sin(ang + centerAng) * dist;
    ctx.fillStyle = `rgba(231,229,228,${0.04 + r() * 0.08})`;
    ctx.fillRect(x, y, 1, 1);
  }
}

// Compact scopes block embedded at top of Develop tab (no outer empty state — always renders since image is present).
function EmbeddedScopes({ image, adj, mode }) {
  const [scopeType, setScopeType] = React.useState('histogram');
  const [expanded, setExpanded] = React.useState(true);
  if (!image) return null;
  const scopes = ['histogram', 'waveform', 'parade', 'vectorscope'];
  return (
    <div style={{ padding: '12px 0 6px', borderBottom: `0.5px solid ${MapleTokens.border}`, marginBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <div onClick={() => setExpanded(!expanded)} style={{
          display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer',
          fontFamily: MapleFont, fontSize: 10, fontWeight: 600,
          color: MapleTokens.textMuted, letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>
          <MapleIcon name={expanded ? 'chevron-down' : 'chevron-right'} size={10} color={MapleTokens.textMuted} strokeWidth={2}/>
          <span>Scopes</span>
        </div>
        {expanded && (
          <div style={{ display: 'flex', gap: 2 }}>
            {scopes.map(s => (
              <div key={s} onClick={() => setScopeType(s)} title={s}
                style={{
                  padding: '2px 5px', borderRadius: 3,
                  fontFamily: MapleMono, fontSize: 9,
                  background: scopeType === s ? MapleTokens.primaryDim : 'transparent',
                  color: scopeType === s ? MapleTokens.primary : MapleTokens.textMuted,
                  cursor: 'pointer', textTransform: 'uppercase', letterSpacing: 0.4,
                }}>{s.slice(0, 4)}</div>
            ))}
          </div>
        )}
      </div>
      {expanded && (
        <ScopeCanvas type={scopeType} imageId={image.id} adj={adj} channels={{ r: true, g: true, b: true }}/>
      )}
      {expanded && mode !== 'full' && (
        <div style={{ fontFamily: MapleFont, fontSize: 10, color: MapleTokens.textMuted, padding: '6px 0 0', textAlign: 'center' }}>
          Open image for live updates
        </div>
      )}
    </div>
  );
}

Object.assign(window, { ScopesTab, EmbeddedScopes });
