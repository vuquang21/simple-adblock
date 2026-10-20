# Simple AdBlock

A Chrome Manifest V3 ad blocker that blocks by domain list, hides the leftover ad boxes, and
lets you pick a banner by hand on a site the lists do not cover. No account, no telemetry, no
remote code — the whole extension is the files in this folder.

## Install for yourself or a friend (unpacked)

1. Download the release zip (or run `node tools/package.js` and take
   `dist/simple-adblock-<version>.zip`).
2. Unzip it. Keep the folder: Chrome reads it in place, it is not a temporary installer.
3. Open `chrome://extensions` and turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the unzipped folder.
5. Pin the extension from the puzzle-piece menu; the popup is where the per-site controls live.

Requires Chrome (or any Chromium: Edge, Brave, Opera) **121 or newer** — the manifest pins that
version for the 30,000-rule dynamic limit.

Unpacked copies do not auto-update: after a new version, replace the folder and press the reload
arrow on the card in `chrome://extensions`. Tabs that were already open keep the old content
scripts until they are reloaded; the picker injects itself, so picking still works.

## Install from a store

Nothing to unzip, install and updates are automatic.

- Chrome Web Store: not published yet.
- Edge Add-ons: not published yet.

To publish: `node tools/package.js --store` and upload the resulting zip. The `--store` build
drops the `declarativeNetRequestFeedback` permission, which Chrome grants to unpacked copies
only — a published build keeps the permission and then silently never gets the matched-rule
counts the popup asks for. Both call sites already tolerate its absence.

## After installing

- Open the dashboard (**Open dashboard** in the popup) and import a list, or paste one in. The
  starter list is already loaded, so ads are gone before you import anything.
- A banner that survives: open the popup on that page → **Block an element on this page** →
  click the box. The rule is stored for that host only and the box disappears immediately.
- A site that breaks: **Allow ads on this site** in the popup. That turns off both network
  blocking and element hiding there.
- Untick **Hide ad boxes automatically** if the automatic pass ever eats something it should not.

## Development

```
node test/parse.test.js && node test/background.test.js && node test/cosmetic.test.js
node test/picker.test.js && node test/auto-hide.test.js && node test/youtube-main.test.js
```

Plain Node and `assert`, no dependencies, no `package.json`. Two hand-run generators, both
committed output — they are not a build stage:

```
node tools/build-cosmetic.js easylist.txt   # regenerates cosmetic-rules.js
node tools/build-icons.js                   # regenerates icons/icon-*.png
node tools/package.js                       # builds dist/simple-adblock-<version>.zip
```

Architecture notes, storage keys and the reasons behind the guards live in
[`.claude/CLAUDE.md`](.claude/CLAUDE.md); the rules agents must not get wrong are in
[`AGENTS.md`](AGENTS.md).

## What it cannot block

- YouTube ads served from the same host as the video: those are skipped inside the player, not
  blocked at the network level.
- A banner drawn inside a third-party iframe cannot be picked (the picker is top-frame only);
  block the iframe's host instead.
- Ad containers whose names are minted per deploy (`css-1q2w3e`) cannot be named in a shipped
  list. That is what the picker and the per-site rules are for.

## License

See [`LICENSE`](LICENSE).
