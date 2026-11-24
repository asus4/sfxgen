/** Undo history with gesture coalescing: a knob drag is one step, however many values it passed through. */

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** What made the last step, and when; a new change with the same tag soon after joins that step. */
  tag: string | null;
  at: number;
}

export const HISTORY_LIMIT = 200;
export const COALESCE_MS = 900;

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], tag: null, at: 0 };
}

export function pushHistory<T>(h: History<T>, next: T, tag: string | null, now: number): History<T> {
  if (next === h.present) return h;
  if (tag !== null && tag === h.tag && now - h.at < COALESCE_MS) return { ...h, present: next, future: [], at: now };
  const past = [...h.past, h.present];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, present: next, future: [], tag, at: now };
}

/** Ends the running gesture, so the next change with the same tag starts a new step. */
export function sealHistory<T>(h: History<T>): History<T> {
  return h.tag === null ? h : { ...h, tag: null };
}

export function undoHistory<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  const past = h.past.slice(0, -1);
  return { past, present: h.past[h.past.length - 1], future: [h.present, ...h.future], tag: null, at: 0 };
}

export function redoHistory<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), tag: null, at: 0 };
}
