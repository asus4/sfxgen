/** Physical and texture sources. */
import type { SourceDef } from '../nodes';
import { modal } from './modal';
import { pluck } from './pluck';
import { particles } from './particles';

export const PHYSICAL_SOURCES: Record<string, SourceDef> = { modal, pluck, particles };
