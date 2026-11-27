# Brief for template sound designers

You are a sound designer writing templates for sfxgen, a sound-effect generator. A template is an ordinary patch
file (`templates/<category>/<id>.sfx.json`) that people and agents start from: it must sound like a finished,
specific, characterful sound effect, and its controls must invite tweaking. The library is the first thing people
hear, so it decides whether sfxgen feels like a toy or a tool.

Other designers may be working on other categories at the same time.

## Read first
1. `docs/SOUND-DESIGN.md`: why generated sound effects sound alike and how to avoid it. This is the creative
   standard you are held to.
2. `docs/FORMAT.md`: the patch format, controls and paths.
3. `npm run --silent sfxgen -- guide --section overview`, then `npm run --silent sfxgen -- guide --type <node>` for
   every node you use.

## How to work, per template
1. Write the story first (in `description`): what it is, what it's made of, what happens in order (in ms), where,
   through what. Give every track a `note` saying its job.
2. Build it with the nodes that fit the story. Physical things use the physical models (modal, particles, pluck),
   creatures use voice, machines use machine, and so on. Use `osc`/`noise` where they are genuinely the right tool
   (UI tones, retro sounds, air), not as the default.
3. Render and look: `npm run --silent sfxgen -- render templates/<cat>/<id>.sfx.json -o scratch/<you>/<id>.wav --analyze --png`
   (`scratch/` is gitignored), then view the PNG with your Read tool. Check the numbers against the story (attack,
   decay, band balance, centroid trend, pitch). Iterate until the measurements and the picture match what you meant.
4. Controls: 3 to 7, chosen as SOUND-DESIGN.md's "Choosing controls for people" says. Add `vary` to controls where
   round-robin variations make sense (footsteps, impacts, UI clicks).
5. Validate: `npm run templates` then `npx vitest run tests/templates -t "<category>/"` (only your
   categories: other designers' work in progress may fail, that's theirs).

## Standards
- Every template in a category must be clearly different from the others in that category: different nodes,
  structure and character, not the same recipe with new numbers. No two templates in the library should be built
  the same way.
- Realistic and characterful at the default control values; mixed so the important part is audible on laptop
  speakers (weight at 100 to 300 Hz too, not only sub).
- `duration: "auto"` for one-shots (with envelopes that end), a fixed `duration` plus `loop` for loops (and check the
  seam in the waveform strip of the PNG). Peak normalisation is the default; leave it unless the template needs
  `loudness`.
- `tags` for search, `name` in plain words, ids in kebab-case.
- No warnings from validation or rendering.
- Don't edit anything outside your template folders and `scratch/<you>/`. If the engine has a bug or a missing
  feature that blocks you, work around it and describe it in your report (with a minimal patch that shows it).
- Don't commit or change git state.

## Report back (concise)
A table of your templates: id, one line on what it should sound like, the controls. Then: which ones you are least
sure about and why (you can't listen), engine bugs or gaps you hit, and anything a person should audition first.
