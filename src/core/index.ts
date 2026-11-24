/** The DOM-free core: format, rendering, analysis. Runs in a browser worker and in Node. */
export * from './format/types';
export { validatePatch, formatIssues, suggest, type Issue, type ValidationResult } from './format/validate';
export { getPath, setPath, splitPath, deepClone } from './format/paths';
export { syncControlBases, controlsSetting, type SyncChange } from './format/sync';
export { applyControls, applyControl, controlPosition, controlValueAt, mapValue, varyPatch, variationTakes, takeFileName } from './format/controls';
export { render, renderVoice, estimateDuration, compileEvents, TrackCache, type RenderOptions, type RenderResult, type TrackRender } from './render';
export { encodeWav, decodeWav, type DecodedWav } from './wav';
export {
  getSource,
  getEffect,
  listSources,
  listEffects,
  metaAt,
  sourceParamMeta,
  effectParamMeta,
  ENVELOPE_FIELDS,
  TRACK_FIELDS,
  REPEAT_FIELDS,
  MASTER_FIELDS,
  BUS_FIELDS,
  PATCH_FIELDS,
} from './registry';
export { COMMON_SOURCE_PARAMS, COMMON_EFFECT_PARAMS, type ParamMeta, type ParamMap, type SourceDef, type EffectDef, type NodeDef, type VoiceContext, type FxContext } from './nodes';
export { loudness } from './analysis/loudness';
export { Rng, hashString } from './dsp/rng';
export {
  PROJECT_FORMAT_ID,
  PROJECT_FILE,
  soundName,
  soundExportPath,
  groupOf,
  projectPatch,
  renderProjectSound,
  matchLoudness,
  newProject,
  validateProject,
  type Project,
  type ProjectSound,
  type ProjectGroup,
  type SoundLevel,
} from './project/project';
