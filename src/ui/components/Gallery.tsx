/** The template gallery: every sound in the library, one click to load and hear. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { getTemplate, listTemplates, templateCategories, type TemplateSummary } from '../../core/templates';
import { addBlankSound, importFile, pickTemplate } from '../controller';
import { inkAt, textOn } from '../lib/inks';
import { renderClient } from '../renderClient';
import { useEditor } from '../store';
import { Icon } from './Icon';
import { Segmented } from './Widgets';

const BINS = 72;
const thumbs = new Map<string, Promise<Float32Array | null>>();

function thumbFor(id: string): Promise<Float32Array | null> {
  let p = thumbs.get(id);
  if (!p) {
    const patch = getTemplate(id);
    p = patch ? renderClient.thumb(patch, BINS).then((r) => r.peaks).catch(() => null) : Promise.resolve(null);
    thumbs.set(id, p);
  }
  return p;
}

function MiniWave({ id }: { id: string }) {
  const el = useRef<SVGSVGElement>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    let alive = true;
    // Render only the cards that scroll into view.
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        void thumbFor(id).then((p) => alive && setPeaks(p));
      },
      { rootMargin: '120px' },
    );
    io.observe(node);
    return () => {
      alive = false;
      io.disconnect();
    };
  }, [id]);
  const d = useMemo(() => {
    if (!peaks) return '';
    let top = '';
    let bottom = '';
    for (let i = 0; i < BINS; i++) {
      const x = ((i + 0.5) / BINS) * 100;
      top += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${(20 - Math.min(1, peaks[i * 2 + 1]) * 18 - 0.4).toFixed(1)}`;
      bottom = `L${x.toFixed(1)} ${(20 - Math.max(-1, peaks[i * 2]) * 18 + 0.4).toFixed(1)}${bottom}`;
    }
    return `${top}${bottom}Z`;
  }, [peaks]);
  return (
    <svg ref={el} className={`mini-wave${peaks ? ' is-ready' : ''}`} viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <path d={d || 'M0 20H100'} />
    </svg>
  );
}

/** Categories take inks in library order, so neighbours never share one until the set runs out. */
function categoryInk(category: string): string {
  return inkAt(Math.max(0, templateCategories().indexOf(category)));
}

function Card({ t, loaded }: { t: TemplateSummary; loaded: boolean }) {
  const ink = categoryInk(t.category);
  return (
    <button type="button" className={`card${loaded ? ' is-loaded' : ''}`} style={{ '--c': ink, '--on-ink': textOn(ink) } as React.CSSProperties} onClick={() => pickTemplate(t.id)}>
      <span className="card-wave">
        <MiniWave id={t.id} />
        <span className="card-play">
          <Icon name="play" size={18} fill />
        </span>
      </span>
      <span className="card-name">{t.name}</span>
      <span className="card-desc">{t.description}</span>
      <span className="card-meta">
        <span className="chip chip-ink">{t.category}</span>
        {t.controls.slice(0, 3).map((c) => (
          <span key={c.id} className="chip">
            {c.label}
          </span>
        ))}
        {t.controls.length > 3 && <span className="chip">+{t.controls.length - 3}</span>}
      </span>
      {loaded && <span className="card-stamp">loaded</span>}
    </button>
  );
}

export function Gallery() {
  const open = useEditor((s) => s.gallery.open);
  const mode = useEditor((s) => s.gallery.mode);
  const file = useRef<HTMLInputElement>(null);
  const current = useEditor((s) => (s.patch.meta as { template?: string } | undefined)?.template);
  const [category, setCategory] = useState('');
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const categories = useMemo(() => templateCategories(), []);
  const items = useMemo(() => listTemplates({ category: category || undefined, query }), [category, query]);
  const close = () => useEditor.setState({ gallery: { open: false, mode } });
  const setMode = (m: 'replace' | 'add') => useEditor.setState({ gallery: { open: true, mode: m } });

  useEffect(() => {
    if (open) search.current?.focus();
  }, [open]);

  if (!open) return null;
  return (
    <div className="drawer-layer">
      <div className="scrim" onClick={close} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Template gallery">
        <header className="drawer-head">
          <h2 className="panel-title">Gallery</h2>
          <button type="button" className="key key-icon" onClick={close} aria-label="Close the gallery">
            <Icon name="close" />
          </button>
        </header>
        <div className="drawer-tools">
          <div className="row">
            <Segmented
              label="What a click does"
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'replace', label: 'Replace the open sound' },
                { value: 'add', label: 'Add as a new pad' },
              ]}
            />
            <span className="spacer" />
            <button type="button" className="key key-sm" onClick={addBlankSound}>
              <Icon name="plus" size={12} /> Blank
            </button>
            <button type="button" className="key key-sm" onClick={() => file.current?.click()} title="Add a .sfx.json file. You can also drop one anywhere, or paste a patch (Ctrl+V or ⌘V)">
              <Icon name="open" size={12} /> File
            </button>
            <input
              ref={file}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importFile(f);
                e.target.value = '';
              }}
            />
          </div>
          <label className="search">
            <Icon name="search" size={16} />
            <input ref={search} type="search" placeholder="Search sounds: laser, thud, click…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search templates" />
          </label>
          <div className="cats" role="radiogroup" aria-label="Category">
            <button type="button" role="radio" aria-checked={category === ''} className={`chip chip-btn${category === '' ? ' is-on' : ''}`} onClick={() => setCategory('')}>
              all
            </button>
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={category === c}
                className={`chip chip-btn${category === c ? ' is-on' : ''}`}
                style={{ '--c': categoryInk(c), '--on-ink': textOn(categoryInk(c)) } as React.CSSProperties}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <div className="cards">
          {items.map((t) => (
            <Card key={t.id} t={t} loaded={t.id === current} />
          ))}
          {items.length === 0 && <p className="empty">Nothing matches “{query}”. Try fewer words.</p>}
        </div>
        <footer className="drawer-foot">
          {items.length} of {listTemplates().length} sounds · a click {mode === 'add' ? 'adds a pad' : 'loads it into the open pad'} and plays it
        </footer>
      </aside>
    </div>
  );
}
