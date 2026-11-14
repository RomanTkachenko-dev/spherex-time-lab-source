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
