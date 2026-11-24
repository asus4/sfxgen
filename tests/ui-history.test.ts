import { describe, expect, it } from 'vitest';
import { COALESCE_MS, HISTORY_LIMIT, createHistory, pushHistory, redoHistory, sealHistory, undoHistory } from '../src/ui/lib/history';

describe('undo history', () => {
  it('undoes and redoes', () => {
    let h = createHistory('a');
    h = pushHistory(h, 'b', null, 0);
    h = pushHistory(h, 'c', null, 1);
    expect(h.present).toBe('c');
    h = undoHistory(h);
    expect(h.present).toBe('b');
    h = undoHistory(h);
    expect(h.present).toBe('a');
    expect(undoHistory(h)).toBe(h);
    h = redoHistory(redoHistory(h));
    expect(h.present).toBe('c');
    expect(redoHistory(h)).toBe(h);
  });

  it('makes one step of a gesture', () => {
    let h = createHistory(0);
    for (let i = 1; i <= 20; i++) h = pushHistory(h, i, 'control:pitch', i * 16);
    expect(h.present).toBe(20);
    expect(h.past).toEqual([0]);
    expect(undoHistory(h).present).toBe(0);
  });

  it('starts a new step for another tag, after a pause, or once sealed', () => {
    let h = createHistory(0);
    h = pushHistory(h, 1, 'a', 0);
    h = pushHistory(h, 2, 'b', 10);
    expect(h.past).toEqual([0, 1]);
    h = pushHistory(h, 3, 'b', 10 + COALESCE_MS + 1);
    expect(h.past).toEqual([0, 1, 2]);
    h = sealHistory(h);
    h = pushHistory(h, 4, 'b', 10 + COALESCE_MS + 2);
    expect(h.past).toEqual([0, 1, 2, 3]);
  });

  it('drops the redo stack on a new change and ignores a no-op', () => {
    let h = pushHistory(pushHistory(createHistory('a'), 'b', null, 0), 'c', null, 1);
    h = undoHistory(h);
    expect(h.future).toEqual(['c']);
    expect(pushHistory(h, h.present, null, 2)).toBe(h);
    h = pushHistory(h, 'd', null, 3);
    expect(h.future).toEqual([]);
    expect(h.past).toEqual(['a', 'b']);
  });

  it('keeps a bounded past', () => {
    let h = createHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 50; i++) h = pushHistory(h, i, null, i);
    expect(h.past.length).toBe(HISTORY_LIMIT);
    expect(h.past[h.past.length - 1]).toBe(HISTORY_LIMIT + 49);
  });
});
