# AGENTS.md — Simple AdBlock

Instructions for coding agents working in this repo. The architecture notes live in
[`.claude/CLAUDE.md`](.claude/CLAUDE.md): read it before changing a script you have not touched
yet, and update it in the same change as any behavior change. This file only holds what is easy
to get wrong.

## Language

- Answer the user in **Vietnamese**. Code, comments, commit messages and docs stay in English.

## Ground rules

- No build step, no dependencies, no bundler, no `package.json` — raw files the browser loads.
  `tools/build-cosmetic.js` is a hand-run generator, not a build stage.
- Chrome MV3. `minimum_chrome_version` 121 is pinned for the 30k safe dynamic DNR rule limit; do
  not raise or lower it casually.
- `cosmetic-rules.js` is GENERATED. Never edit it by hand — regenerate with
  `node tools/build-cosmetic.js easylist.txt`.

## Before you claim it works

```
node test/parse.test.js && node test/background.test.js && node test/cosmetic.test.js
node test/picker.test.js && node test/auto-hide.test.js && node test/youtube-main.test.js
```

- No framework: plain Node + `assert`, with a fake `chrome` / DOM running the real file in a `vm`.
  New behavior needs a case in the matching test file — and a new **guard** needs a case too.
  These files test what the code must refuse to do at least as much as what it does.
- Test messages must say why ("a menu is not a banner"), not just restate the assertion.

## Things that bite here

- A new content script has to be listed in three places: `manifest.json` → `content_scripts[].js`,
  the injection order in `popup.js` (`armPicker`), and the file list in the test that loads it.
- Every selector lands in one generated stylesheet, so one bad selector, `/*` or quote swallows
  every rule after it. All selectors pass `safeSelector()` first, and each rule goes on its own
  line (`injectHiding`), never comma-joined.
- Hiding the wrong node is far worse than leaving one ad: page wrappers, `article`, `video`, nav
  bars, and anything covering more than half the viewport are off limits — see `pickContainer()`
  in `picker.js` and `autoShaped()` in `auto-hide.js`.
- Automatic hiding is a heuristic judged by its false positives. Adding a signal means adding the
  case where it must *not* fire, plus the `AUTO_MAX_HIDES` style cap if the signal can mass-match.
- UI code only writes `chrome.storage.local`; `background.js` owns DNR rules and reacts to
  `storage.onChanged`. Storage keys are documented in `.claude/CLAUDE.md`.
- Comments explain *why*. A known limit gets a `shortcut:` comment saying when to upgrade it.

## Reporting

- Say what changed per file, what the tests now cover, and what still cannot be blocked. The user
  is usually chasing one specific banner, so end with the exact next step (reload the extension,
  Pick this box, add this brand host) rather than a general summary.
