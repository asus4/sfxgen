/** Physical and texture sources: modal, pluck, particles. Owned by the physical-sources work. */
import type { SourceDef } from '../nodes';
import { modal } from './modal';
import { pluck } from './pluck';
import { particles } from './particles';

export const PHYSICAL_SOURCES: Record<string, SourceDef> = { modal, pluck, particles };
