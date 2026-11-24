/**
 * The effect catalog. Add a new effect by writing its EffectDef in its own file and listing it in one of the
 * catalog files.
 */
import type { EffectDef } from '../nodes';
import { filter } from './filter';
import { drive } from './drive';
import { gain } from './gain';
import { SHAPE_EFFECTS } from './catalog-shape';
import { SPACE_EFFECTS } from './catalog-space';

export const EFFECTS: Record<string, EffectDef> = {
  filter,
  drive,
  gain,
  ...SHAPE_EFFECTS,
  ...SPACE_EFFECTS,
};
