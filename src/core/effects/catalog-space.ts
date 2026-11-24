/** Effects of time, space, pitch and medium. Owned by the space-effects work. */
import type { EffectDef } from '../nodes';
import { reverb } from './reverb';
import { delay } from './delay';
import { resonator } from './resonator';
import { varispeed } from './varispeed';
import { pitch } from './pitch';
import { doppler } from './doppler';
import { medium } from './medium';

export const SPACE_EFFECTS: Record<string, EffectDef> = {
  reverb,
  delay,
  resonator,
  varispeed,
  pitch,
  doppler,
  medium,
};
