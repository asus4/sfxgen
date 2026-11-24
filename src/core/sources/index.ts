/**
 * The source catalog. Add a new source by writing its SourceDef in its own file and listing it in one of the
 * catalog files.
 */
import type { SourceDef } from '../nodes';
import { osc } from './osc';
import { noise } from './noise';
import { PHYSICAL_SOURCES } from './catalog-physical';
import { TONAL_SOURCES } from './catalog-tonal';

export const SOURCES: Record<string, SourceDef> = {
  osc,
  noise,
  ...TONAL_SOURCES,
  ...PHYSICAL_SOURCES,
};
