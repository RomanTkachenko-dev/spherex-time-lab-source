"""Network-free tests of the reproducible astrometry audit's selection rules."""
from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse

import validate_release_matrix as matrix


class MatrixChecks(unittest.TestCase):
    def test_capacity_split_keeps_all_declared_days(self):
        requests=[]
        def response(url,timeout):
            query={key:values[0] for key,values in parse_qs(urlparse(url).query).items()}
            requests.append(query)
            if query['start']!=query['end']:
                raise HTTPError(url,413,'capacity',{},BytesIO(b'capacity'))
            record={'observation':query['start'],'detector':1,'mjd':1,'id':query['start']}
            return BytesIO(json.dumps({'query':query,'records':[record],
                'source_url':'https://irsa.ipac.caltech.edu/SIA','source_sha256':'a'*64,
                'retrieved_at':'2026-09-29T00:00:00Z','matched_count':1,'catalogue_truncated':False}).encode())
        with tempfile.TemporaryDirectory() as folder,patch.object(matrix,'urlopen',side_effect=response):
            result=matrix.collect_catalogue('http://localhost',{'start':'2026-07-20','end':'2026-07-22'},Path(folder))
        self.assertEqual([p['start'] for p in result['observation_table_parts']],['2026-07-20','2026-07-21','2026-07-22'])
        self.assertEqual(result['matched_count'],3)
        self.assertEqual(len(result['records']),3)
        self.assertEqual(requests[0]['end'],'2026-07-22')

    def test_unsplittable_day_reports_capacity_without_sampling(self):
        def response(url,timeout):raise HTTPError(url,413,'capacity',{},BytesIO(b'capacity'))
        with tempfile.TemporaryDirectory() as folder,patch.object(matrix,'urlopen',side_effect=response):
            with self.assertRaisesRegex(ValueError,'no result has been sampled'):
                matrix.collect_catalogue('http://localhost',{'start':'2026-07-20','end':'2026-07-20'},Path(folder))
            attempts=json.loads((Path(folder)/'query_attempts.json').read_text())
            self.assertEqual(attempts[0]['status'],413)


if __name__=='__main__':unittest.main()
