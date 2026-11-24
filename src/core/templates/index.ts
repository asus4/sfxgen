/**
 * The template library: every templates/**\/*.sfx.json, collected into library.json by `npm run templates`.
 * A template is an ordinary patch whose controls are chosen for people to tweak.
 */
import type { Patch } from '../format/types';
import { deepClone } from '../format/paths';
import library from './library.json';

export interface TemplateEntry {
  /** Path under templates/ without the extension, such as "impacts/metal-hit". */
  id: string;
  category: string;
  patch: Patch;
}

const ENTRIES = library as unknown as TemplateEntry[];

export interface TemplateSummary {
  id: string;
  category: string;
  name: string;
  description: string;
  tags: string[];
  controls: { id: string; label: string; hint?: string }[];
}

function summary(e: TemplateEntry): TemplateSummary {
  return {
    id: e.id,
    category: e.category,
    name: e.patch.name,
    description: e.patch.description ?? '',
    tags: e.patch.tags ?? [],
    controls: (e.patch.controls ?? []).map((c) => ({ id: c.id, label: c.label, hint: c.hint })),
  };
}

export function templateCategories(): string[] {
  return [...new Set(ENTRIES.map((e) => e.category))];
}

/** Templates matching an optional category and a free-text query over name, description, tags and id. */
export function listTemplates(filter: { category?: string; query?: string } = {}): TemplateSummary[] {
  const words = (filter.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return ENTRIES.filter((e) => !filter.category || e.category === filter.category)
    .filter((e) => {
      if (words.length === 0) return true;
      const hay = [e.id, e.patch.name, e.patch.description ?? '', ...(e.patch.tags ?? [])].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .map(summary);
}

/** A fresh copy of a template's patch, or undefined. */
export function getTemplate(id: string): Patch | undefined {
  const e = ENTRIES.find((t) => t.id === id);
  if (!e) return undefined;
  const patch = deepClone(e.patch);
  patch.meta = { ...(patch.meta ?? {}), template: id };
  return patch;
}

export function allTemplates(): TemplateEntry[] {
  return ENTRIES;
}
