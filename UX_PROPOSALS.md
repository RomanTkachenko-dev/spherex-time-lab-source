# UX proposals: SPHEREx Time Lab for newcomers

Two personas:

- **A. Curious adult.** No astronomy background, on a phone or laptop. Doesn't know what SPHEREx, RA/Dec, FITS or "wavelength" mean.
- **B. Hackathon judge.** Has about 2 minutes and needs to understand what the tool does, see it work, and believe it is real data.

Effort: S = under 1 h, UI only. M = half a day. L = more than a day.
Risk to logic: none / low / needs logic (touches frozen science, API or data code).

**Status:** ✅ done on `ui-polish`. ◻ proposal only.

## Done (S effort, no logic risk)

| # | Persona | Problem | Change | Effort | Risk | Status |
|---|---|---|---|---|---|---|
| 1 | A, B | Nothing says what the tool is for. On phones the intro text and section labels are hidden | One-line purpose + numbered 3-step strip ("Pick a spot → Press play → Judge what moved") above the globe, visible at every width; hidden in embed mode | S | none | ✅ |
| 2 | A, B | The three areas of the page have no clear order | Section labels "SKY MAP · STEP 1", "STEP 2 · WATCH", "STEP 3 · CHECK"; globe footer "1 Find a spot → 2 Watch → 3 Judge what moved" | S | none | ✅ |
| 3 | A | RA/Dec, detector, field of view, wavelength and quality overlay are unexplained | Short help and tooltips: RA/Dec "sky coordinates in degrees, like longitude and latitude"; detector "six detectors, each sees a different range of infrared"; FOV "full Moon ≈ 0.5°"; wavelength "infrared colour"; quality overlay "pixels the archive flagged as suspicious; data underneath is kept" | S | none | ✅ |
| 4 | A | "Fixed sky / Track comet", "Query centre", "IRSA prediction" are opaque | Tooltips explaining what changes (stars still vs. image follows the object) and that the dashed circle is not a detection | S | none | ✅ |
| 5 | A | Errors read like log lines ("Запит не виконано", "Некоректна відповідь архіву") | Friendly, actionable texts ("The NASA archive didn't respond. Try again in a minute.", "Try a longer date range or one of the ready-made examples") | S | none | ✅ |
| 6 | A | Empty states don't say what to do next | "No saved sessions yet. Open an example or build a series…", "No exposures match these settings. Try a longer date range…", placeholders "e.g. M101 or NGC 6822" | S | none | ✅ |
| 7 | B | Example buttons don't say what they show | "3I/ATLAS: Comet · 12 exposures in 2 hours", "M101: Pinwheel Galaxy", "Moving object: asteroid or comet" | S | none | ✅ |
| 8 | A | Field-search dialog starts with dense text | Description rewritten as 3 steps: pick an example or name → choose dates → we fetch and line up every picture | S | none | ✅ |
| 9 | A, B | The method dialog opens with technical detail | New "In short" paragraph at the top in plain language; the technical sections are unchanged in meaning | S | none | ✅ |
| 10 | A | "Hemisphere" (zoom reset) is unclear | Renamed "Zoom out fully" | S | none | ✅ |
| 11 | B | On the Pages demo the search button is disabled with no explanation | Hint under the button: archive search needs the full (server) version | S | none | ✅ |
| 12 | A | "Science laboratory" looks like a required step | Renamed "Science lab (advanced)", with an open/closed chevron | S | none | ✅ |

### Follow-up round

| # | Persona | Problem | Change | Effort | Risk | Status |
|---|---|---|---|---|---|---|
| 13 | A, B | Only 7 thumbnails were visible; the rest of the series felt missing | Scrollable strip with **all** exposures, virtualised for large series, pause markers, selected exposure kept in view | M | none | ✅ |
| 14 | A | "What is that dot?": the wide globe and the 256-px exposures were two unrelated maps | **Globe ↔ viewer link**: the globe centre is a cyan cross on the images; clicking an image moves the globe there (switch to DSS2 to compare visible light); "Show on the globe ↑" | M | none (display-only projection, tested against pipeline markers) | ✅ |

**Who the link is for:** someone who sees a blob or a moving dot in the SPHEREx exposures and wants to know what it is. They click it, the globe flies there, and they can compare the infrared mosaic with the DSS2 visible-light survey or search by name around it. In the other direction, someone who found a named star or galaxy on the globe sees exactly where it falls in the exposures. **Limits:** fixed-sky view only; the background mosaic combines many dates, so a moving object will not appear at the same place on the globe.

## Proposals (not implemented)

| # | Persona | Problem | Change | Effort | Risk |
|---|---|---|---|---|---|
| P1 | B | The judge must find the comet by eye | **Autoplay the 3I/ATLAS example** on first visit (muted, stops on any interaction), with a pulsing ring on the predicted position for the first loop | M | low (UI state only; must not change saved session view) |
| P2 | A | Can't tell what changed between two exposures | **Blink / difference toggle** in Compare mode: alternate the two PNGs at 2 Hz, or show a CSS `mix-blend-mode:difference` overlay. Display only | M | low (display only; must be labelled "visual aid, not a measurement") |
| P3 | A | Comet motion is easy to miss at 256 px | **Zoom/pan on the frame** (CSS transform, pixelated) with a 2×/4× toggle | M | none |
| P4 | A, B | First-time users don't know where to click | **Guided 4-step tour** (popover anchored to globe → example → play → inspector), dismissible and remembered in localStorage | M | none |
| P5 | B | No visible "result" moment | **Shareable link** to the current exposure and compare state (the URL already carries sky coordinates; extend to frame index) | M | low (URL format is UI, but `readAtlasLink` lives in lib/sky-atlas.ts: review first) |
| P6 | A | Units (µm, µJy, MJD, ″) appear without explanation | **Glossary popover** ("?" next to each unit) generated from the glossary in UI_AUDIT.md | M | none |
| P7 | A | Long Ukrainian/English texts in the inspector on phones | Collapse the inspector into an accordion on ≤720 px; keep the first card (time, wavelength) open | S–M | none |
| P8 | all | Runtime messages are translated by regex at display time | Producers emit **message codes + params** (e.g. `{code:"IRSA_TIMEOUT"}`) and the UI renders them in either language | L | **needs logic** (lib/irsa-catalogue.ts, workers, API) |
| P9 | all | Exported JSON metadata and saved series titles stay Ukrainian | Store titles language-neutral (`{kind:"field", ra, dec}`) and render at display time | L | **needs logic** (manifest/session format) |
| P10 | A | Plural forms are approximated ("{n} кадрів") | Use `Intl.PluralRules` in `translate()` with `one/few/many` keys | S–M | none |
| P11 | B | 551 kB JS chunk slows first paint on the demo | Lazy-load the science lab and field-search dialog (`React.lazy`) | M | low |
| P12 | A | The globe needs WebGL2; it fails on old phones | Static fallback image of the sky with the two example buttons when WebGL2 is unavailable | M | none |
