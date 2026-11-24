/** Effects that shape tone, dynamics and movement. Owned by the shape-effects work. */
import type { EffectDef } from '../nodes';
import { eq } from './eq';
import { compressor } from './compressor';
import { limiter } from './limiter';
import { transient } from './transient';
import { gate } from './gate';
import { crush } from './crush';
import { tremolo } from './tremolo';
import { ringmod } from './ringmod';
import { chorus } from './chorus';
import { flanger } from './flanger';
import { phaser } from './phaser';
import { width } from './width';
import { reverse } from './reverse';
import { formant } from './formant';

export const SHAPE_EFFECTS: Record<string, EffectDef> = {
  eq,
  compressor,
  limiter,
  transient,
  gate,
  crush,
  tremolo,
  ringmod,
  chorus,
  flanger,
  phaser,
  width,
  reverse,
  formant,
};
