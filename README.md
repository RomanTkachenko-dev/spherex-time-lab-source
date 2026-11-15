# SPHEREx Time Lab

Explore the SPHEREx DR1 sky mosaic, compare individual exposures, and inspect candidate trajectories against Gaia DR3. The bundled 3I/ATLAS example and calibration assets are runtime inputs. Observation dates, calibration versions and source references preserve scientific provenance.

## Run locally

Use Node.js 24 and npm.

```sh
npm ci
npm run dev
npm test
npm run build
```

Open http://localhost:5173. Live archive queries require internet access and the included server routes. GitHub Pages requires a static frontend plus a separate backend for those routes.

## Reproduce the data preparation

Use Python 3.11 in a virtual environment.

```sh
python -m pip install -r research/requirements.txt
python -m unittest discover -s research -p 'test_*.py'
python research/build_dataset.py
python research/build_lab_calibration.py
```

Results and archive caches are generated locally. Candidate associations are positional and may be incomplete. Photometry and candidate recovery on real crowded backgrounds remain under validation.

[SPHEREx archive](https://irsa.ipac.caltech.edu/Missions/spherex.html) · [Calibration documentation](https://caltech-ipac.github.io/irsa-tutorials/spherex-psf/)


## GitHub Pages and live search

The Pages demo includes 3I/ATLAS and four DR1 D2 exposures of the same field from August 2025 to February 2026. Rebuild the latter with `python research/build_epoch_demo.py`. It is a selected example, not the complete archive result.

To enable live archive access, deploy the API with `npx wrangler deploy --config wrangler.api.jsonc` from an authorized Cloudflare account. Set `SITE_ORIGIN` in that configuration to your frontend origin, and set the repository Actions variable `PAGES_API_ORIGIN` to the resulting HTTPS Worker origin (no trailing slash). Run the Pages workflow again. CORS is a browser policy, not access control for server clients. Configure service quotas for the public API before advertising it widely.

The per-track Gaia search records individual catalogue queries, truncation and failures. Its finite padding can miss high proper-motion sources. Candidate detection fits nearby point-source amplitudes and records the peaks omitted by its compute budget. Photometric errors still omit unmeasured systematics. The observer-specific small-body check is described by `research/identify_small_bodies.py`.

## Site structure

The GitHub Pages build has an overview page at the site root, the lab under `lab/` and an About page under `about/`. The static pages live in `pages/` and share `pages/site.css`. Old links that pass lab parameters to the root (for example `?ra=…&dec=…`) are forwarded to `lab/` with the same query.

## Deep links and embedding

Use decimal ICRS degrees, RA in [0, 360) and Dec in [-90, 90].
Supported options: `lang=en|uk`, `ra`, `dec`, `fov` (map degrees),
`start`, `end` (ISO UTC dates), `detector=1..6`, `release=dr1|qr3`,
`survey=wide|deep`, and `embed=1` for a compact layout.
Add `search=1` with valid coordinates and both dates to run the coverage query on load.

Example iframe:

```html
<iframe title="SPHEREx Time Lab"
  src="https://romantkachenko-dev.github.io/spherex-time-lab-source/lab/?ra=167.2&amp;dec=5.15&amp;start=2025-12-14&amp;end=2025-12-14&amp;detector=5&amp;search=1&amp;embed=1&amp;lang=en"
  width="100%" height="850" loading="lazy"></iframe>
```
