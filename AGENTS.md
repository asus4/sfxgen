# AGENTS.md

sfxgen is a sound-effect generator: sounds are JSON patches (`*.sfx.json`) rendered by a deterministic
TypeScript DSP engine that runs in the browser and in Node. Read [docs/DESIGN.md](docs/DESIGN.md) for the
architecture and [docs/FORMAT.md](docs/FORMAT.md) for the patch format.

## Making sounds

If you are here to make sound effects rather than to change sfxgen:

1. Read [docs/SOUND-DESIGN.md](docs/SOUND-DESIGN.md). It explains why generated sound effects tend to sound alike
   and how to avoid it. Then run `npm run sfxgen -- guide` for the catalog of sources and effects.
2. Start from the nearest template (`npm run sfxgen -- templates --search door`) or from scratch, write the story in
   `description` and each track's `note`, and render with `npm run sfxgen -- render my.sfx.json --analyze --png`.
3. Read the analysis and look at the spectrogram PNG. You can't hear the sound, so check the measurements against
   the story and say what you could not check. `analyze my.sfx.json --tracks` renders each layer on its own and
   marks any 30 dB or more under the loudest: the usual reason a layer seems to do nothing.
4. Choose 3 to 7 `controls` a person should try, named in a listener's words, each tested at both ends. A control's
   `set` targets override the file's own values at their paths, so after editing run `npm run sfxgen -- sync my.sfx.json`
   to make the file say what renders (`--check` in CI).
5. Hand it over: `npm run sfxgen -- serve .` opens the editor on the same files. When you have more than one idea for
   a sound, write takes (`<name>.takes/<label>.sfx.json` next to it) rather than separate sounds: the person picks one.
6. The person approves each sound or flags it as needing work in the editor, and tells you what to change in the
   chat. Run `npm run sfxgen -- review` before changing anything: it lists their verdicts, the take they kept and the
   knobs they turned (already in the files, so build on them).

## Changing sfxgen

| Command | Does |
| --- | --- |
| `npm run dev` | The editor with hot reload, at http://localhost:5178 |
| `npm run sfxgen -- <command>` | The CLI from source (`npm run sfxgen -- --help` lists the commands) |
| `npm test` | All tests |
| `npm run typecheck` | TypeScript |
| `npm run templates` | Rebuild `src/core/templates/library.json` after changing `templates/` |
| `npm run build` | Templates, the editor (`dist/web`) and the CLI (`dist/node`) |

Rules:

- **Determinism.** Same patch, seed and sample rate, same samples, everywhere. All randomness goes through
  `ctx.rng.fork('purpose')`; never `Math.random` in the core.
- **The core stays DOM-free.** `src/core/` runs in a worker and in Node. Browser-only code is in `src/ui/`,
  `src/worker/` and `src/web/`; Node-only code in `src/node/`.
- **Metadata is the source of truth.** A source or effect declares every parameter in `ParamMeta` with a `doc` an
  agent can act on, a `hint` for people (a few plain words on what they hear: the editor's tooltip), a unit, a soft
  range, hard limits that keep it stable, `scale: 'log'` for frequencies and times and `pitch: true` on
  frequency-like parameters; the node itself has a `doc` and a `hint` too. Validation, the editor, the guide and the
  schema read it. Never reword a `doc` lightly: it also names random streams, so the sound would change.
- **Effects use `mode`, not `type`, for their own shape enum**: `type` names the node.
- **Test every node** with defaults and extreme values: finite, not silent, sane level, and its key behaviour.
- **Templates** are plain patches under `templates/<category>/`, held to [docs/TEMPLATE-BRIEF.md](docs/TEMPLATE-BRIEF.md)
  (the brief to hand an agent writing them). Run `npm run templates` and the template test after adding one.
- **Format changes** need `docs/FORMAT.md`, `src/core/format/types.ts` and the validator changed together.
