# sfxgen

An in-browser SFX generator 🎛️

**[Open the editor 🔗: asus4.github.io/sfxgen](https://asus4.github.io/sfxgen/)**

## Make a sound

1. Press **Gallery** and pick a template: impacts, footsteps, doors, UI clicks, retro blips, sci-fi, creatures,
   magic, nature and more. It plays as soon as you pick it.
2. Turn the **Easy control** knobs; the sound plays when you let go. The **dice** keep the sound and roll new random
   detail. **Surprise me** throws every knob somewhere new.
3. Open **Full control** for every parameter of every layer, the mixer for a whole set of sounds, and the settings
   the set shares.
4. **Export** a WAV (one sound or the whole set), or **Share** a link with the sound inside it.

Your projects are kept in your browser. **Save** downloads a sound as a `.sfx.json` file; drop or paste one onto the
page to bring it back.

## Make a sound with an AI agent

There are two ways to bring in an agent.

**WebMCP in the browser**: the editor offers its tools to an AI agent running in your browser: it finds a template,
edits the sound, renders and measures it, and plays it for you in the open page. Chrome turns WebMCP on for the
hosted editor by itself; elsewhere, set `chrome://flags/#enable-webmcp-testing` to Enabled. The editor's **WebMCP**
key shows how.

**CLI on your computer**: ask your coding agent to "set up https://github.com/asus4/sfxgen and make me ...".
[AGENTS.md](AGENTS.md) is where it starts, and [docs/SOUND-DESIGN.md](docs/SOUND-DESIGN.md) is how to make sounds.
It renders every sound, reads the measurements and looks at the spectrogram before handing it over, and
`sfxgen serve` opens the editor on the same files so you can hear and tune them.

The command line runs from a clone of this repository:

```bash
git clone https://github.com/asus4/sfxgen.git
cd sfxgen
npm install
npm run sfxgen -- templates                          # browse the library
npm run sfxgen -- new impacts/thud -o thud.sfx.json  # start from a template
npm run sfxgen -- render thud.sfx.json --analyze --png
npm run sfxgen -- serve .                            # edit the same files in the browser
npm run sfxgen -- review                             # what the person approved or flagged
npm run sfxgen -- project init sounds/               # make a folder of patches a project
npm run sfxgen -- build sounds/                      # render every sound to its export path
```

## License

- Source code: [MIT](LICENSE)
- SFX you make: no license, you own them.
