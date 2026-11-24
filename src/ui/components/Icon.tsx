/** A small set of line icons, drawn to match the 2 px ink outlines. */
const PATHS: Record<string, string> = {
  play: 'M7 4.5v15l13-7.5z',
  stop: 'M6 6h12v12H6z',
  undo: 'M9 7 4 12l5 5M4 12h10a6 6 0 0 1 0 12h-2',
  redo: 'M15 7l5 5-5 5M20 12H10a6 6 0 0 0 0 12h2',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  open: 'M3 7h6l2 2h10v10H3z',
  save: 'M5 4h11l4 4v12H5zM8 4v5h7V4M8 20v-6h8v6',
  export: 'M12 3v12M7 10l5 5 5-5M4 20h16',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  pin: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v7',
  close: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  up: 'M6 14l6-6 6 6',
  down: 'M6 10l6 6 6-6',
  power: 'M12 3v9M7 6a8 8 0 1 0 10 0',
  wave: 'M2 12h2l2-6 3 12 3-16 3 14 2-8 2 4h3',
  spectro: 'M4 5h16M4 10h10M4 15h13M4 20h6',
  spark: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  ear: 'M8 14a5 5 0 1 1 9-3c0 3-3 3-3 6a3 3 0 0 1-5 2M11 11a2 2 0 0 1 3-1',
  curve: 'M3 19C8 19 8 5 13 5s4 9 8 9',
  flat: 'M3 12h18',
  copy: 'M8 8h11v12H8zM5 16V4h10',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  sliders: 'M5 4v16M12 4v16M19 4v16M3 9h4M10 15h4M17 8h4',
  agent: 'M12 3l2.2 5.3L20 9l-4.4 3.8L17 19l-5-3-5 3 1.4-6.2L4 9l5.8-.7z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5 20 20',
};

export function Icon({ name, size = 18, fill = false }: { name: string; size?: number; fill?: boolean }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d={PATHS[name] ?? ''}
        fill={fill ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={fill ? 1.5 : 2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

const PIPS: Record<number, [number, number][]> = {
  1: [[12, 12]],
  2: [[8, 8], [16, 16]],
  3: [[7.5, 7.5], [12, 12], [16.5, 16.5]],
  4: [[8, 8], [16, 8], [8, 16], [16, 16]],
  5: [[7.5, 7.5], [16.5, 7.5], [12, 12], [7.5, 16.5], [16.5, 16.5]],
  6: [[8, 7], [16, 7], [8, 12], [16, 12], [8, 17], [16, 17]],
};

/** A die showing a face that follows the seed, so "another take" visibly lands somewhere new. */
export function Die({ seed, size = 20 }: { seed: number; size?: number }) {
  const face = (Math.abs(Math.round(seed)) % 6) + 1;
  return (
    <svg key={seed} className="icon die" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
      {PIPS[face].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="1.7" fill="currentColor" />
      ))}
    </svg>
  );
}
