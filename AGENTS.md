# AGENTS.md

sfxgen is an agent-first sound-effect generator: sounds are JSON patches (`*.sfx.json`) rendered by a deterministic
TypeScript DSP engine that runs in the browser and in Node. Read [docs/DESIGN.md](docs/DESIGN.md) for the
architecture and [docs/FORMAT.md](docs/FORMAT.md) for the patch format.

## Making sounds

If you are here to make sound effects rather than to change sfxgen:

1. Read [docs/SOUND-DESIGN.md](docs/SOUND-DESIGN.md). It explains why generated sound effects tend to sound alike
   and how to avoid it. Then run `npm run sfxgen -- guide` for the catalog of sources and effects.
2. Start from the nearest template (`npm run sfxgen -- templates --search door`) or from scratch, write the story in
   `description` and each track's `note`, and render with `npm run sfxgen -- render my.sfx.json --analyze --png`.
3. Read the analysis and look at the spectrogram PNG. You can't hear the sound, so check the measurements against
   the story and say what you could not check.
4. Choose 3 to 7 `controls` a person should try, named in a listener's words, each tested at both ends.
5. Hand it over: `npm run sfxgen -- serve .` opens the editor on the same files.

## Changing sfxgen

| Command | Does |
| --- | --- |
| `npm run dev` | The editor with hot reload, at http://localhost:5178 |
| `npm run sfxgen -- <command>` | The CLI from source (`render`, `analyze`, `validate`, `guide`, `templates`, `new`, `diff`, `serve`, `mcp`) |
| `npm test` | All tests (vitest) |
| `npm run typecheck` | TypeScript |
| `npm run templates` | Rebuild `src/core/templates/library.json` after changing `templates/` |
| `npm run build` | Templates, the editor (`dist/web`) and the CLI (`dist/node`) |

Rules:

- **Determinism.** Same patch, seed and sample rate, same samples, everywhere. All randomness goes through
  `ctx.rng.fork('purpose')`; never `Math.random` in the core.
- **The core stays DOM-free.** `src/core/` runs in a worker and in Node. Browser-only code is in `src/ui/`,
  `src/worker/` and `src/web/`; Node-only code in `src/node/`.
- **Metadata is the source of truth.** A source or effect declares every parameter in `ParamMeta` with a `doc` an
  agent can act on, a unit, a soft range, hard limits that keep it stable, `scale: 'log'` for frequencies and times
  and `pitch: true` on frequency-like parameters. Validation, the editor, the guide and the schema read it.
- **Effects use `mode`, not `type`, for their own shape enum**: `type` names the node.
- **Test every node** with defaults and extreme values: finite, not silent, sane level, and its key behaviour.
- **Templates** are plain patches under `templates/<category>/`. Each one needs a story in `description`, a `note`
  on each track and 3 to 7 controls that change the sound audibly across their whole range. Run `npm run templates`
  and the template test after adding one.
- **Format changes** need `docs/FORMAT.md`, `src/core/format/types.ts` and the validator changed together.
