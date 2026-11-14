"""Inspect official SPHEREx observation metadata without inventing columns."""
from pathlib import Path
from io import BytesIO
import json
import requests
from astropy.table import Table

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.science-cache'
CACHE.mkdir(exist_ok=True)
URL = 'https://irsa.ipac.caltech.edu/data/SPHEREx/docs/comet3iatlas/obscore_3I_Atlas.vot'
p = CACHE / 'observations.vot'
if not p.exists():
    r = requests.get(URL, timeout=45)
    r.raise_for_status()
    p.write_bytes(r.content)
t = Table.read(p, format='votable')
rows = t[(t['t_min'] > 61000) & (t['spherex_detector'] == 'D5')]
print(json.dumps([{k: str(r[k]) for k in ['obs_id','comet_ra','comet_dec','t_min','access_url']} for r in rows], indent=2))
if len(rows):
    link = requests.get(str(rows[0]['access_url']),timeout=45)
    link.raise_for_status()
    (CACHE/'datalink.vot').write_bytes(link.content)
    table=Table.read(BytesIO(link.content),format='votable')
    print(table.colnames)
    for row in table:
        print({k:str(row[k]) for k in table.colnames})
