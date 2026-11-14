# UI audit: SPHEREx Time Lab (`ui-polish` branch, based on `origin/main` dd9308d)

Scope: everything a user can see in `app/*.tsx` (start screen, sky globe, presets, the field-search
dialog, the viewer, frame navigation, session library, science lab, method dialog, loading/empty/error
states, worker progress messages). Science, data selection, API shapes and pipeline code are out of scope.
The guardrail diff against `origin/main` must stay empty.

Baseline on `origin/main`: `npm test` passes 79/79. `npx vite build --config vite.pages.config.ts` passes, with the
usual >500 kB chunk warning.

## Status (end of `ui-polish`)

| Item | Status | Commit |
|---|---|---|
| B1 demo banner padding | ✅ fixed | `ui-fix: pad and restyle the GitHub Pages demo banner` |
| B2 example buttons active state / aria-pressed | ✅ fixed | `ui-fix: highlight the open example …` |
| B3 document language | ✅ fixed | `ui-fix: set document language to English …` |
| B4 disabled search in Pages build | ✅ hint added | i18n commit |
| B5 atlas dropdowns at 375 px | ✅ fixed | `ui-fix: give atlas dropdowns full width on phones …` |
| B6–B9 untranslated labels / aria | ✅ fixed | i18n commit |
| B10 science-lab open indicator | ✅ chevron | i18n commit |
| R1/R3 English source + full UK dictionary | ✅ 530 keys, test-enforced (`tests/i18n.test.ts`) | i18n commit |
| R2 runtime messages | ✅ ≈250 exact + 40 pattern translations at display time | i18n commits |
| R4 `<html lang>` | ✅ | `ui-fix` |
| T9 series titles | ✅ translated at display time | i18n commit |
| U1–U4 newcomer wording | ✅ see UX_PROPOSALS.md | `ux:` + i18n commits |
| N1–N4 | ⏸ needs logic change, not done | — |

Check: `git grep -nP '"[^"]*[А-Яа-яІіЇїЄєҐґ][^"]*"' -- app` lists only `app/api/**` (frozen, translated at display) and the
"Українська" option. Lint baseline unchanged (one existing `set-state-in-effect` error in `observatory.tsx`); new warnings
are `exhaustive-deps` for `t` inside effects, intentionally left out of dependency arrays so a language switch
doesn't restart the globe or background load.

## Glossary (use these terms in both languages)

| English (UI) | Українська (UI) | Meaning for a newcomer |
|---|---|---|
| exposure | експозиція | One picture SPHEREx took of the sky (one FITS file). In the viewer, "frame" means the same thing |
| frame | кадр | One exposure as shown in the viewer; frames are numbered 1…N in time order |
| time series / series | часова серія / серія | Several exposures of the same patch of sky, sorted by time |
| epoch | епоха | A moment of observation; "different epochs" means pictures taken months apart |
| visit | візит | A pass of the telescope over a field (only used in help text) |
| field / sky field | поле / ділянка неба | The patch of sky being looked at |
| field of view (FOV) | поле зору | How wide the picture is, in degrees (1° ≈ two full Moons) |
| RA / Dec | RA / Dec (пряме піднесення / схилення) | Sky "longitude/latitude" in degrees (ICRS) |
| wavelength | довжина хвилі | Colour of infrared light, in µm (мкм) |
| detector (D1–D6) | детектор (D1–D6) | One of the six SPHEREx detectors, each covering a wavelength range |
| quality overlay | шар якості | Orange layer that marks pixels the archive flagged as suspicious |
| reference exposure | опорний кадр | The second frame you compare the current one against |
| predicted position | прогнозоване положення | Where a catalogue *expects* the object (not a measurement) |
| query centre | центр запиту | The coordinates you asked for (not a detection) |
| series metadata (passport) | паспорт серії | A JSON record of sources, checksums and settings, used for reproducibility |
| bundle (.spherex) | пакет (.spherex) | One file with the metadata plus all images, for moving a session to another device |
| saved job / checkpoint | збережене обчислення / контрольна точка | An unfinished build that can be resumed |
| release (DR1, QR3) | реліз (DR1, QR3) | Version of the published SPHEREx data |
| Wide / Deep Survey | Wide / Deep Survey | Two survey modes (kept in English as proper names) |

## Architecture of the problem (grouped root causes)

| # | Root cause | Where | Fix once |
|---|---|---|---|
| R1 | The i18n layer is **Ukrainian-source with a partial UK→EN map** (`lib/language.ts`, 133 entries). About 70% of strings never go through `t()`. Interpolated strings (counts, dates) can't be translated at all. | all `app/*.tsx` | Make English the source language: `t("English", {vars})` plus a full EN→UK dictionary with `{placeholder}` interpolation. Every component uses the same hook. |
| R2 | **Runtime messages are Ukrainian.** They come from `lib/*`, the workers (`public/science/*.mjs`, `*.py`) and the API (`app/api/**`). All of these are frozen. | error banners, progress lines, exclusion reasons, flag text, series titles | Add a display-time translator `useMessage()` in `lib/runtime-messages.ts`: exact matches plus regex patterns from UK to EN, applied only where a message is rendered. No producer changes. |
| R3 | `science-lab.tsx`, `session-library.tsx` and `method.tsx` don't use `t()` at all. | 3 files | Covered by R1 |
| R4 | Document language: `<html lang="uk">` in `pages/index.html` and `app/layout.tsx`, plus a Ukrainian `<title>`/description, while the default UI language is English | layout | Set `lang="en"` and English metadata; the runtime switcher already updates `document.documentElement.lang` |

## Findings

Severity: **H** blocks or misleads the user, **M** visible defect, **L** polish.
"Safe" means it can be fixed in the UI layer only.

### Bugs / layout

| ID | Where | Problem | Type | Sev | Safe |
|---|---|---|---|---|---|
| B1 | `app/observatory.tsx:243` (`p.intro[role=note]`) | GitHub Pages demo banner has no side padding and touches the window edge at every width. It uses the 16px `.intro` style. It is Ukrainian-only | layout | M | yes |
| B2 | `app/observatory.tsx:246` | The two example buttons (`.target`) show `cursor:default` although they are clickable. The "DR1 field" example is never highlighted when open. "3I/ATLAS" is highlighted whenever the open series is not a field. Neither button exposes `aria-pressed` | bug/a11y | M | yes (UI state only) |
| B3 | `pages/index.html:2`, `app/layout.tsx` | `lang="uk"` and a Ukrainian title while the default UI is English. Screen readers use the wrong voice before hydration | a11y | M | yes |
| B4 | `app/sky-atlas.tsx:188` | In the Pages build, "Find SPHEREx coverage" is permanently disabled with no explanation | unclear | M | yes (helper text) |
| B5 | `app/sky-atlas.css` ≤480px | The two `<select>`s ("Sky background", "Mosaic channel") sit side by side at 375px, so option text is cut ("SPHEREx DR1 · in") | layout | L | yes |
| B6 | `app/method.tsx:5`, `app/session-library.tsx:48` | Dialog close buttons have a hard-coded Ukrainian `aria-label="Закрити"` | a11y/i18n | L | yes |
| B7 | `app/observatory.tsx:248` | The passport button label is untranslated in its idle state (`t()` is applied only to the busy label) | untranslated | M | yes |
| B8 | `app/observatory.tsx:44,90-95` | Exposure tiles, the image `alt`, the marker `aria-label`, the orientation tooltip, "Field ≈", the loading and error texts are all Ukrainian | untranslated/a11y | M | yes |
| B9 | `app/sky-atlas.tsx:179` | The "Mosaic spectral channel" label is missing from the dictionary. The language is chosen inline with `language==="uk"?…`, which duplicates logic | untranslated | M | yes |
| B10 | `app/science-lab.css` `.lab-open` | The science-lab toggle has no open/closed indicator | unclear | L | yes |

### Untranslated / unclear text (grouped)

| ID | Where | What | Sev |
|---|---|---|---|
| T1 | `observatory.tsx` (≈60 strings) | dataset details, view-mode tabs, marker labels, the Gaia status block, the spectral notice, the viewer caption, the series report, the inspector (wavelength, flags, technical metadata), the strip caption, slider labels | H |
| T2 | `field-search.tsx` (≈90 strings) | intro, preset cards, the name resolver, coordinate hints, the moving-target / Horizons guide, advanced options, the progress block, checkpoints, the results table, every validation error | H |
| T3 | `science-lab.tsx` (≈80 strings) | everything | H (server build only) |
| T4 | `session-library.tsx` (≈25 strings) | everything | H |
| T5 | `method.tsx` (≈15 paragraphs) | the whole "How to read these images" dialog | H |
| T6 | `frame-navigation.tsx` | the 3 notices | M |
| T7 | `sky-atlas.tsx` | map errors, background status, credit line, result help, the "Catalogue sources" detail | M |
| T8 | runtime (R2) | ≈250 messages from lib/workers/API (see list in the commit that adds `lib/runtime-messages.ts`) | H |
| T9 | `public/data/epochs/manifest.json` title "Поле DR1 · різні епохи", pipeline titles "Поле 167.2000°, +5.1500°", "… · поле ICRS", "… · рухома ціль" | series title shown in the heading | M |
| U1 | header | "Sky changes lab" doesn't say what the tool is for. The start screen has no one-line purpose | M |
| U2 | sky globe | "Hemisphere" button: unclear (it resets zoom to the widest view) | L |
| U3 | viewer | "Fixed sky / Track comet" doesn't explain what changes | L |
| U4 | many | Jargon in the main flow (ICRS, FLAGS, MJD, PSF, WCS) without explanation. Kept in the method/technical sections, softened in labels | M |

### Needs logic change (not done)

| ID | Where | Why it is out of scope |
|---|---|---|
| N1 | `lib/science.ts` `describeFlags`, `lib/field-query.ts`, `lib/catalogue-*.ts`, `public/science/*`, `app/api/**` | Messages are produced in Ukrainian inside frozen code. They are translated at display time (R2), but a message whose wording changes upstream will fall back to Ukrainian. A message-code API would be the proper fix |
| N2 | `app/api/evidence/route.ts` | The exported JSON passport contains Ukrainian descriptive fields ("IndexedDB у браузері…"). This is a file format, so it is left unchanged |
| N3 | `public/science/field_pipeline.py` | `title` and `target_description` are written into the manifest in Ukrainian. They are translated on display; saved bundles keep Ukrainian |
| N4 | `lib/catalogue-batches.ts` | Progress details are composed with numbers inside Ukrainian sentences. They are handled by regex patterns, so a wording change upstream would break the match |
