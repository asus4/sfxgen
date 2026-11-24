/** The agent's presence: what it wrote about the sound and each layer, and a feed of who changed what. */
import { useEffect, useState } from 'react';
import { trackInk } from '../lib/inks';
import { useEditor, type Activity } from '../store';
import { Icon } from './Icon';

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

const WHO: Record<Activity['origin'], string> = { agent: 'agent', human: 'you', file: 'file', system: 'editor' };

export function AgentPanel() {
  const description = useEditor((s) => s.patch.description);
  const tracks = useEditor((s) => s.patch.tracks);
  const tags = useEditor((s) => s.patch.tags);
  const activity = useEditor((s) => s.activity);
  const select = useEditor((s) => s.select);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => setNow(Date.now()), [activity]);
  const notes = tracks.map((t, i) => ({ t, i })).filter(({ t }) => t.note);

  return (
    <aside className="agent" aria-label="Agent notes and activity">
      <div className="note">
        <h2 className="note-title">
          <Icon name="agent" size={15} fill /> Agent notes
        </h2>
        {description ? <p className="note-text">{description}</p> : <p className="note-text is-empty">No description yet. An agent (or you, under Everything → Master &amp; patch) can say what this sound is for.</p>}
        {notes.length > 0 && (
          <ul className="note-tracks">
            {notes.map(({ t, i }) => (
              <li key={t.id}>
                <button type="button" onClick={() => select(t.id)} style={{ '--c': trackInk(t, i) } as React.CSSProperties}>
                  <i className="dot" />
                  <b>{t.name ?? t.id}</b>
                  <span>{t.note}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {tags && tags.length > 0 && (
          <p className="note-tags">
            {tags.map((tag) => (
              <span key={tag} className="chip">
                {tag}
              </span>
            ))}
          </p>
        )}
      </div>
      <div className="feed">
        <h2 className="feed-title">Activity</h2>
        <ol aria-live="polite">
          {activity.slice(0, 12).map((a) => (
            <li key={a.id} className={`feed-item from-${a.origin}`}>
              <span className="who">{WHO[a.origin]}</span>
              <span className="what">{a.text}</span>
              <time>{ago(a.at, now)}</time>
            </li>
          ))}
          {activity.length === 0 && <li className="feed-item is-empty">Nothing yet.</li>}
        </ol>
      </div>
    </aside>
  );
}
