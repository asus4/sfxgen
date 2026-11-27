/** Tonal and character sources. */
import type { SourceDef } from '../nodes';
import { fm } from './fm';
import { additive } from './additive';
import { voice } from './voice';
import { machine } from './machine';
import { chaos } from './chaos';

export const TONAL_SOURCES: Record<string, SourceDef> = { fm, additive, voice, machine, chaos };
