"""Scientific display kernel for native Python and Pyodide. No detections inferred.

All numerical work uses actual calibrated IMAGE/FLAGS and WCS-WAVE from IRSA.
The output is for visual inspection, not quantitative photometry/astrometry.
"""
from io import BytesIO
from hashlib import sha256
from datetime import datetime, timezone
from bisect import bisect_left
import base64
import json
import warnings
import numpy as np
import astropy
from astropy import units as u, log
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS
import scipy
from scipy.ndimage import map_coordinates
import PIL
from PIL import Image

log.setLevel('ERROR')
INFO_MASK = (1 << 21) | (1 << 12)
BAD_MASK = np.uint32(0xffffffff ^ INFO_MASK)
METHOD = 'field-viewer-0.8.0'
ATTRIBUTION = 'This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration.'

def display_wcs(ra, dec, width_deg, n=256):
    w = WCS(naxis=2)
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.cdelt = [-width_deg / n, width_deg / n]
    w.wcs.crval = [ra, dec]
    w.wcs.ctype = ['RA---TAN', 'DEC--TAN']
    w.wcs.radesys = 'ICRS'
    return w

def project(a, flags, native, output, n=256):
    y, x = np.indices((n, n), dtype=float)
    ra, dec = output.all_pix2world(x, y, 0)
    sx, sy = native.all_world2pix(ra, dec, 0, quiet=True)
    outside = ~np.isfinite(sx) | ~np.isfinite(sy)
    # Inverse WCS transforms can return a boundary pixel as -1e-13 or
    # (N-1)+1e-13 due only to floating-point roundoff. Accept a tiny fraction
    # of a pixel, then clip those roundoff-only excursions before interpolation.
    tolerance = 1e-7
    footprint = (~outside &
                 (sx >= -tolerance) & (sx <= a.shape[1] - 1 + tolerance) &
                 (sy >= -tolerance) & (sy <= a.shape[0] - 1 + tolerance))
    sample_x = np.clip(np.nan_to_num(sx, nan=-1.0), 0, a.shape[1] - 1)
    sample_y = np.clip(np.nan_to_num(sy, nan=-1.0), 0, a.shape[0] - 1)
    coords = [np.where(footprint, sample_y, -1), np.where(footprint, sample_x, -1)]
    invalid = ~np.isfinite(a) | ((flags.astype(np.uint32) & BAD_MASK) != 0)
    samples = map_coordinates(np.nan_to_num(a), coords, order=1, mode='constant', cval=0, prefilter=False)
    mask = map_coordinates(invalid.astype(float), coords, order=1, mode='constant', cval=1, prefilter=False) > 0
    missing = map_coordinates((~np.isfinite(a)).astype(float), coords, order=1, mode='constant', cval=1, prefilter=False) > 0
    samples[missing | ~footprint] = np.nan
    mask |= ~footprint
    return samples, mask, footprint

def coverage_metrics(samples, mask, footprint):
    footprint = np.asarray(footprint, dtype=bool)
    mask = np.asarray(mask, dtype=bool)
    denominator = int(np.count_nonzero(footprint))
    finite = int(np.count_nonzero(footprint & np.isfinite(samples)))
    usable = int(np.count_nonzero(footprint & np.isfinite(samples) & ~mask))
    return {
        'coverage_fraction': float(footprint.mean()),
        'finite_pixel_count': finite,
        'finite_coverage_fraction': float(finite / denominator) if denominator else 0.0,
        'usable_coverage_fraction': float(usable / denominator) if denominator else 0.0,
        'flagged_display_fraction': float(mask.mean())
    }

def spectral_at(h, x, y):
    w = WCS(h['IMAGE'].header, fobj=h, key='W')
    w.sip = None  # Spatial SIP distortion does not belong to the spectral WCS.
    wavelength, width = w.all_pix2world(x, y, 0)
    return (float((float(wavelength) * u.Unit(w.world_axis_units[0])).to_value(u.um)),
            float((float(width) * u.Unit(w.world_axis_units[1])).to_value(u.um)))

def is_proper_motion(ephemeris):
    return bool(ephemeris) and str(ephemeris.get('source', '')).startswith('Proper motion')

def ephemeris_title(ephemeris):
    return f"{ephemeris['target_name']} · " + ('власний рух' if is_proper_motion(ephemeris) else 'рухома ціль')

def ephemeris_description(ephemeris):
    if is_proper_motion(ephemeris):
        r = ephemeris['reference']
        origin = (f"{ephemeris['resolver']} ({ephemeris['source_url']}, отримано {ephemeris['retrieved_at']})"
                  if ephemeris.get('source_url') else 'значення, введені користувачем')
        return (f"Каталожна позиція RA {r['ra']:.7f}°, Dec {r['dec']:+.7f}° епохи J{r['epoch_jyear']:g} і власний рух "
                f"({r['pm_ra_masyr']:+.3f}, {r['pm_dec_masyr']:+.3f}) мас/рік: {origin}. Позиція на DATE-AVG поширена сталим "
                "власним рухом без паралаксу та променевої швидкості. Це прогноз, не вимірювання SPHEREx. ")
    return (f"Імпортована таблиця {ephemeris['source']} ({ephemeris['source_file_name']}, SHA-256 {ephemeris['source_sha256']}); "
            "Earth geocenter, ICRF, UTC; позиція на DATE-AVG отримана сферичною інтерполяцією. Це прогноз, не вимірювання SPHEREx. ")

def ephemeris_position(ephemeris, mjd):
    points = ephemeris['points']
    times = [point['mjd'] for point in points]
    if not times[0] <= mjd <= times[-1]:
        raise ValueError('Ефемерида не покрива середину експозиції DATE-AVG.')
    hi = int(np.searchsorted(times, mjd, side='left'))
    if hi == 0 or times[hi] == mjd:
        point = points[hi]
        return float(point['ra']), float(point['dec'])
    lo = hi - 1
    a, b = points[lo], points[hi]
    fraction = (mjd - a['mjd']) / (b['mjd'] - a['mjd'])
    def unit(ra, dec):
        ra, dec = np.radians([ra, dec])
        return np.array([np.cos(dec)*np.cos(ra), np.cos(dec)*np.sin(ra), np.sin(dec)])
    va, vb = unit(a['ra'], a['dec']), unit(b['ra'], b['dec'])
    angle = np.arccos(np.clip(np.dot(va, vb), -1.0, 1.0))
    if angle < 1e-12:
        v = va + fraction * (vb - va)
    else:
        v = np.sin((1-fraction)*angle)/np.sin(angle)*va + np.sin(fraction*angle)/np.sin(angle)*vb
    v /= np.linalg.norm(v)
    return float(np.degrees(np.arctan2(v[1], v[0])) % 360), float(np.degrees(np.arcsin(np.clip(v[2], -1, 1))))

def png_uri(array):
    stream = BytesIO()
    Image.fromarray(np.flipud(array)).save(stream, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(stream.getvalue()).decode('ascii')

def display_gray(samples, low, high):
    """Render finite signal consistently; missing data get a visible texture."""
    scaled = np.clip((np.nan_to_num(samples, nan=low) - low) / (high - low), 0, 1)
    gray = np.uint8(np.arcsinh(scaled * 18) / np.arcsinh(18) * 255)
    y, x = np.indices(samples.shape)
    missing = ~np.isfinite(samples)
    gray[missing] = np.where(((x // 8 + y // 8) % 2)[missing], 32, 56)
    return gray

def process_fits(raw, record, query):
    with fits.open(BytesIO(raw), memmap=False) as h:
        release = query.get('release', 'qr2')
        survey = query.get('survey', 'wide')
        collection = f"spherex_{release}" + ("_deep" if survey == 'deep' else '')
        if record.get('release') != collection:
            raise ValueError('Реліз або тип огляду FITS не відповідає запиту.')
        header = h['IMAGE'].header
        if str(header['OBSID']) != record['observation'] or int(header['DETECTOR']) != query['detector']:
            raise ValueError('Ідентичність FITS не відповідає запису архіву.')
        if str(header.get('TIMESYS', '')).upper() != 'UTC':
            raise ValueError('Часова шкала FITS не є UTC.')
        a = h['IMAGE'].data.astype(float)
        a *= u.Unit(header['BUNIT']).to(u.MJy / u.sr)
        flags = h['FLAGS'].data.astype(np.uint32)
        if a.ndim != 2 or flags.shape != a.shape:
            raise ValueError('Розміри IMAGE та FLAGS не узгоджені.')
        native = WCS(header)
        ra, dec = query['ra'], query['dec']
        target = query.get('ephemeris')
        most = query.get('most')
        if target:
            position_ra, position_dec = ephemeris_position(target, float(header['MJD-AVG']))
        elif most:
            position_ra, position_dec = float(record['target_ra']), float(record['target_dec'])
            if not (0 <= position_ra < 360 and -90 <= position_dec <= 90):
                raise ValueError('IRSA MOST повернув некоректні координати зіставленої цілі.')
        else:
            position_ra, position_dec = ra, dec
        x, y = (float(v) for v in native.all_world2pix(position_ra, position_dec, 0))
        if not (np.isfinite(x) and np.isfinite(y) and 0 <= x <= a.shape[1]-1 and 0 <= y <= a.shape[0]-1):
            return None, 'Цільова координата на час експозиції поза зображенням.' if target else 'Центр запиту поза зображенням.'
        rx, ry = native.all_pix2world(x, y, 0)
        residual = float(SkyCoord(rx*u.deg, ry*u.deg).separation(SkyCoord(position_ra*u.deg, position_dec*u.deg)).arcsec)
        if residual > 1e-3:
            raise ValueError('Зворотне перетворення WCS неузгоджене.')
        wave, width = spectral_at(h, x, y)
        if not (np.isfinite(wave) and np.isfinite(width) and wave > 0 and width > 0):
            return None, 'Некоректна спектральна калібрація в центрі поля.'
        if query.get('wavelength_min') is not None and not query['wavelength_min'] <= wave <= query['wavelength_max']:
            return None, 'Довжина хвилі в центрі поля поза вибраним інтервалом.'
        output = display_wcs(ra, dec, query['fov'])
        sky, mask, footprint = project(a, flags, native, output)
        moving = bool(target or most)
        object_output = display_wcs(position_ra, position_dec, query['fov']) if moving else output
        object_sky, object_mask, object_footprint = project(a, flags, native, object_output)
        sky_x, sky_y = (float(v) for v in output.all_world2pix(position_ra, position_dec, 0))
        object_x, object_y = (float(v) for v in object_output.all_world2pix(position_ra, position_dec, 0))
        sky_marker_visible = bool(np.isfinite(sky_x) and np.isfinite(sky_y) and 0 <= sky_x <= 255 and 0 <= sky_y <= 255)
        marker_sky = {'x': sky_x if sky_marker_visible else 127.5, 'y': 255 - sky_y if sky_marker_visible else 127.5}
        marker_object = {'x': object_x, 'y': 255 - object_y}
        metrics = coverage_metrics(sky, mask, footprint)
        target_metrics = coverage_metrics(object_sky, object_mask, object_footprint)
        primary_metrics = target_metrics if moving else metrics
        if primary_metrics['finite_pixel_count'] == 0:
            return None, 'У проєкції цілі немає скінченних значень IMAGE.' if moving else 'У проєкції поля немає скінченних значень IMAGE.'
        native_flags = int(flags[int(round(y)), int(round(x))])
        fwhm = header.get('PSF_FWHM')
        fwhm = float(fwhm) if fwhm is not None and np.isfinite(float(fwhm)) else None
        frame = {
            'id': str(header['OBSID']) + 'D' + str(query['detector']),
            'observation_id': str(header['OBSID']), 'detector': 'D'+str(query['detector']),
            'release': collection, 'date': header['DATE-AVG'], 'date_start': header['DATE-BEG'],
            'date_end': header['DATE-END'], 'mjd': float(header['MJD-AVG']), 'time_scale': 'UTC',
            'exposure_s': float(header['XPOSURE']), 'ra': position_ra, 'dec': position_dec,
            'position_kind': ('catalogue-proper-motion-propagated' if is_proper_motion(target) else 'user-supplied-horizons-ephemeris') if target else ('irsa-most-matched-position' if most else 'requested-sky-position'), 'measurement': None,
            'wavelength_um': wave, 'bandwidth_um': width,
            'spectral_calibration': 'Approximate WCS-WAVE value at requested field centre',
            'marker_sky': marker_sky, 'marker_sky_visible': sky_marker_visible, 'marker_object': marker_object,
            'source_url': record['url'], 'cutout_url': record['cutout_url'],
            'sha256_cutout': sha256(raw).hexdigest(), 'retrieved_at': record['retrieved_at'],
            'native_shape': list(a.shape), 'native_pixel': {'x': x, 'y': y},
            'brightness_unit': 'MJy / sr',
            'quality': {'level1': header.get('L1DQAFLG', 'unknown'), 'level2': header.get('L2DQAFLG', 'unknown'),
                **metrics,
                'target_coverage_fraction': target_metrics['coverage_fraction'],
                'target_finite_pixel_count': target_metrics['finite_pixel_count'],
                'target_finite_coverage_fraction': target_metrics['finite_coverage_fraction'],
                'target_usable_coverage_fraction': target_metrics['usable_coverage_fraction'],
                'target_flagged_display_fraction': target_metrics['flagged_display_fraction'],
                'flags_at_position': native_flags, 'bad_at_position': bool(native_flags & int(BAD_MASK)),
                'median_psf_fwhm_arcsec': fwhm, 'coordinate_roundtrip_arcsec': residual}
        }
        return (frame, sky, object_sky, mask, object_mask), None

def finalize_series(items, catalogue, excluded, runtime):
    if len(items) < 2:
        raise ValueError(f'Після перевірки залишилося кадрів: {len(items)}. Для часової серії потрібно щонайменше два. Розширте дати або діапазон довжин хвиль.')
    items = sorted(items, key=lambda item: (item[0]['mjd'], item[0]['id']))
    maximum = int(catalogue['query']['max_frames'])
    if len(items) > maximum:
        first, last = items[0][0]['mjd'], items[-1][0]['mjd']
        chosen, previous = [], -1
        for slot in range(maximum):
            target = first + (last-first)*slot/(maximum-1)
            lower, upper = previous+1, len(items)-(maximum-slot)
            after = min(upper, max(lower, bisect_left([item[0]['mjd'] for item in items], target, lower, upper+1)))
            before = max(lower, after-1)
            index = before if abs(items[before][0]['mjd']-target) <= abs(items[after][0]['mjd']-target) else after
            chosen.append(index)
            previous = index
        chosen_set = set(chosen)
        excluded.extend({'id': item[0]['id'], 'reason': 'Придатний кадр-кандидат поза рівномірною вибіркою, обмеженою max_frames.'} for i,item in enumerate(items) if i not in chosen_set)
        items = [items[i] for i in chosen]
    moving = bool(catalogue['query'].get('ephemeris') or catalogue['query'].get('most'))
    finite = np.concatenate([a[np.isfinite(a)] for item in items for a in (item[2] if moving else item[1],)])
    low, high = [float(v) for v in np.percentile(finite, [12, 99.7])]
    if not high > low:
        raise ValueError('Не вдалося визначити спільну шкалу яскравості.')
    frames = []
    for frame, sky, object_sky, sky_mask, object_mask in items:
        sky_gray = display_gray(sky, low, high)
        object_gray = display_gray(object_sky, low, high)
        sky_overlay = np.zeros((*sky_mask.shape, 4), dtype=np.uint8)
        object_overlay = np.zeros((*object_mask.shape, 4), dtype=np.uint8)
        sky_overlay[sky_mask] = (255, 153, 88, 160)
        object_overlay[object_mask] = (255, 153, 88, 160)
        frame = dict(frame)
        frame['image'] = png_uri(sky_gray)
        frame['object_image'] = png_uri(object_gray)
        frame['quality_mask_image'] = png_uri(sky_overlay)
        frame['object_quality_mask_image'] = png_uri(object_overlay)
        frames.append(frame)
    q = catalogue['query']
    release = q.get('release', 'qr2')
    survey = q.get('survey', 'wide')
    collection = f"spherex_{release}" + ("_deep" if survey == 'deep' else '')
    release_label = release.upper() + (' · Deep Survey' if survey == 'deep' else ' · Wide Survey')
    target = q.get('target')
    ephemeris = q.get('ephemeris')
    most = q.get('most')
    title = f"{most['target_name']} · IRSA MOST" if most else (ephemeris_title(ephemeris) if ephemeris else (f"{target['canonical_name']} · поле ICRS" if target else f"Поле {q['ra']:.4f}°, {q['dec']:+.4f}°"))
    most_source = (f"Пошук рухомої цілі через IRSA MOST SPHEREx; URL і SHA-256 всіх часових частин записані в observation_table_parts. "
                   if len(catalogue.get('observation_table_parts') or []) > 1 else
                   f"Пошук рухомої цілі через IRSA MOST SPHEREx ({most['source_url']}, SHA-256 {most['source_sha256']}). ") if most else ''
    target_description = (f"{most_source}Положення кожного кадру взято з MOST ra_obj/dec_obj; відповідь не надає окремої епохи координати або її невизначеності. Це каталожний збіг, не виявлення SPHEREx. " if most else (ephemeris_description(ephemeris) if ephemeris else (f"Центр поля взято з {target['resolver']} ({target['query_name']}); це каталожні координати, не вимірювання SPHEREx. " if target else '')))
    return {
        'schema_version': 3, 'kind': 'field', 'title': title,
        'description': f"{target_description}SPHEREx {release_label} · D{q['detector']} · {q['start']} — {q['end']}",
        'query': q, 'frames': frames, 'source': 'https://irsa.ipac.caltech.edu/Missions/spherex.html',
        'observation_table_url': catalogue['source_url'], 'observation_table_sha256': catalogue['source_sha256'],
        **({'observation_table_parts': catalogue['observation_table_parts']} if catalogue.get('observation_table_parts') else {}),
        'retrieved_at': catalogue['retrieved_at'], 'processed_at': datetime.now(timezone.utc).isoformat(),
        'attribution': ATTRIBUTION, 'dataset_doi': '10.26131/IRSA678' if release == 'dr1' else '10.26131/IRSA662' if release == 'qr3' else '10.26131/IRSA652', 'method_version': METHOD,
        'archive_collection': collection,
        'software': {'astropy': astropy.__version__, 'numpy': np.__version__, 'scipy': scipy.__version__, 'Pillow': PIL.__version__, **runtime},
        'completeness': {'matched_count': catalogue['matched_count'], 'candidate_count': catalogue.get('candidate_count',len(catalogue['records'])), 'selected_count': len(catalogue['records']),
            'processed_count': len(frames), 'catalogue_truncated': catalogue['catalogue_truncated'],
            'selection': catalogue['selection'], 'excluded': excluded},
        'display': {'width': 256, 'height': 256, 'sky_fov_deg': q['fov'], 'object_fov_deg': q['fov'],
            'sky_center_ra': q['ra'], 'sky_center_dec': q['dec'], 'projection': 'ICRS TAN',
            'orientation': 'North up, East left', 'resampling': 'bilinear, display only',
            'stretch': 'asinh', 'stretch_parameter': 18, 'low_MJy_sr': low, 'high_MJy_sr': high,
            'scale_scope': 'same scale for every frame', 'psf_matched': False,
            'noise_covariance_propagated': False, 'missing_data_style': '8-pixel checkerboard, grayscale 32/56; not measured signal',
            'bad_pixel_policy': 'Signal retained; overlay marks all FLAGS except SOURCE and FULLSAMPLE plus missing support.'},
        'limits': ['The centre marker is the requested coordinate, not an object detection.',
            'Horizons positions are user-supplied geocentric predictions interpolated on the unit sphere to FITS DATE-AVG; they are not detections and do not use the SPHEREx spacecraft location.',
            'IRSA MOST ra_obj/dec_obj values are service-reported matched positions. The response does not provide a separate coordinate epoch or uncertainty; these are not detections.',
            'Ephemeris interpolation accuracy depends on the supplied Horizons cadence and orbit solution; no position uncertainty is propagated.',
            'Proper-motion positions are a catalogue position propagated linearly from its epoch to FITS DATE-AVG; parallax, radial velocity and catalogue uncertainties are not applied, and they are not detections.',
            'Moving-target view is re-centred at the catalogue coordinate for each exposure; fixed-sky view retains one ICRS centre and can place later target markers outside its field.',
            'WCS roundtrip is a consistency check, not an empirical astrometric accuracy measurement.',
            'No PSF or full spectral response matching; brightness differences do not establish temporal variability.',
            'Wavelength filtering is by approximate central wavelength at the field centre, not full response equivalence.',
            'Selection is bounded; excluded exposures and catalogue truncation are recorded.',
            'Reprojected PNGs are for display, not quantitative photometry or astrometry.']
    }

_items = []
def reset_series():
    _items.clear()

def add_frame(path, record_json, query_json):
    with open(path, 'rb') as stream:
        result, reason = process_fits(stream.read(), json.loads(record_json), json.loads(query_json))
    if result is not None:
        _items.append(result)
    return json.dumps({'included': result is not None, 'reason': reason}, ensure_ascii=False)

def finish_series(catalogue_json, excluded_json, runtime_json):
    result = finalize_series(_items, json.loads(catalogue_json), json.loads(excluded_json), json.loads(runtime_json))
    _items.clear()
    return json.dumps(result, ensure_ascii=False, allow_nan=False)

# Large series use two passes so decoded image arrays never accumulate in RAM.
# A signed exponent/mantissa histogram preserves the common percentile scale
# while providing explicit value brackets for its bounded display approximation.
_HIST_MIN_EXP = -1073
_HIST_MAX_EXP = 1024
_HIST_SUBBINS = 128
_HIST_MAG_BINS = (_HIST_MAX_EXP - _HIST_MIN_EXP + 1) * _HIST_SUBBINS
_HIST_ZERO_BIN = _HIST_MAG_BINS
_HIST_BINS = 2 * _HIST_MAG_BINS + 1
_stream_histogram = None
_stream_sample_count = 0

def reset_stream():
    global _stream_histogram, _stream_sample_count
    _stream_histogram = np.zeros(_HIST_BINS, dtype=np.uint64)
    _stream_sample_count = 0

def export_stream_state():
    if _stream_histogram is None:
        raise ValueError('Потокову гістограму ще не створено.')
    indices = np.flatnonzero(_stream_histogram)
    return json.dumps({'version': 1, 'histogram_bins': _HIST_BINS,
        'subbins_per_exponent': _HIST_SUBBINS, 'sample_count': _stream_sample_count,
        'bins': [[int(i), int(_stream_histogram[i])] for i in indices]}, allow_nan=False)

def restore_stream_state(state_json):
    global _stream_histogram, _stream_sample_count
    state = json.loads(state_json)
    count = state.get('sample_count')
    bins = state.get('bins')
    if (state.get('version') != 1 or state.get('histogram_bins') != _HIST_BINS
            or state.get('subbins_per_exponent') != _HIST_SUBBINS
            or type(count) is not int or not 0 <= count <= 2**53-1
            or not isinstance(bins, list) or len(bins) > _HIST_BINS):
        raise ValueError('Контрольна точка гістограми має некоректний формат.')
    restored = np.zeros(_HIST_BINS, dtype=np.uint64)
    seen, total = set(), 0
    for entry in bins:
        if (not isinstance(entry, list) or len(entry) != 2
                or any(type(value) is not int for value in entry)):
            raise ValueError('Контрольна точка містить некоректний інтервал гістограми.')
        index, value = entry
        if not 0 <= index < _HIST_BINS or index in seen or not 0 < value <= 2**53-1:
            raise ValueError('Контрольна точка містить повторений інтервал або некоректний лічильник.')
        seen.add(index)
        restored[index] = value
        total += value
    if total != count:
        raise ValueError('Сума гістограми не узгоджена з кількістю пікселів.')
    _stream_histogram, _stream_sample_count = restored, count
    return json.dumps({'restored': True, 'sample_count': count})

def _add_scale_samples(values):
    global _stream_sample_count
    values = np.asarray(values, dtype=np.float64).ravel()
    values = values[np.isfinite(values)]
    if not values.size:
        return
    absolute = np.abs(values)
    mantissa, exponent = np.frexp(absolute)
    magnitude_bin = (exponent - _HIST_MIN_EXP) * _HIST_SUBBINS + np.floor((mantissa - 0.5) * (2 * _HIST_SUBBINS)).astype(np.int64)
    magnitude_bin = np.clip(magnitude_bin, 0, _HIST_MAG_BINS - 1)
    bins = np.where(values < 0, _HIST_MAG_BINS - 1 - magnitude_bin, _HIST_ZERO_BIN + 1 + magnitude_bin)
    bins[values == 0] = _HIST_ZERO_BIN
    _stream_histogram[:] += np.bincount(bins, minlength=_HIST_BINS).astype(np.uint64)
    _stream_sample_count += int(values.size)

def _hist_bin_interval(index):
    if index == _HIST_ZERO_BIN:
        return 0.0, 0.0
    negative = index < _HIST_ZERO_BIN
    magnitude_bin = _HIST_MAG_BINS - 1 - index if negative else index - _HIST_ZERO_BIN - 1
    exponent_offset, subbin = divmod(magnitude_bin, _HIST_SUBBINS)
    exponent = _HIST_MIN_EXP + exponent_offset
    low = float(np.ldexp(0.5 + subbin / (2 * _HIST_SUBBINS), exponent))
    high = float(np.ldexp(0.5 + (subbin + 1) / (2 * _HIST_SUBBINS), exponent))
    maximum = float(np.finfo(np.float64).max)
    high = min(high, maximum)
    return (-high, -low) if negative else (low, high)

def stream_scale_limits():
    if _stream_histogram is None or _stream_sample_count < 2:
        raise ValueError('Для спільної шкали недостатньо скінченних пікселів.')
    cumulative = np.cumsum(_stream_histogram, dtype=np.uint64)
    def quantile(percent):
        position = percent * (_stream_sample_count - 1)
        rank_low = int(np.floor(position))
        rank_high = int(np.ceil(position))
        bin_low = int(np.searchsorted(cumulative, rank_low + 1, side='left'))
        low_interval = _hist_bin_interval(bin_low)
        low_mid = low_interval[0] + (low_interval[1] - low_interval[0]) / 2
        if rank_high == rank_low:
            return low_mid, low_interval
        bin_high = int(np.searchsorted(cumulative, rank_high + 1, side='left'))
        high_interval = _hist_bin_interval(bin_high)
        high_mid = high_interval[0] + (high_interval[1] - high_interval[0]) / 2
        fraction = position - rank_low
        estimate = low_mid * (1 - fraction) + high_mid * fraction
        bracket = (low_interval[0] * (1 - fraction) + high_interval[0] * fraction,
                   low_interval[1] * (1 - fraction) + high_interval[1] * fraction)
        return estimate, bracket
    low, low_interval = quantile(0.12)
    high, high_interval = quantile(0.997)
    if not np.isfinite(low) or not np.isfinite(high) or not high > low:
        raise ValueError('Не вдалося визначити скінченну спільну шкалу яскравості.')
    return {'low': float(low), 'high': float(high), 'sample_count': _stream_sample_count,
            'algorithm': 'signed-binary-exponent-histogram-v1', 'subbins_per_exponent': _HIST_SUBBINS,
            'low_interval': [float(v) for v in low_interval], 'high_interval': [float(v) for v in high_interval]}

def add_stream_frame(path, record_json, query_json):
    with open(path, 'rb') as stream:
        result, reason = process_fits(stream.read(), json.loads(record_json), json.loads(query_json))
    if result is None:
        return json.dumps({'included': False, 'reason': reason}, ensure_ascii=False)
    frame, sky, object_sky, _sky_mask, _object_mask = result
    query = json.loads(query_json)
    # Validate serializable metadata before committing samples. A rejected
    # frame must not contribute pixels to the accepted series' display scale.
    included_json = json.dumps({'included': True, 'frame': frame}, ensure_ascii=False, allow_nan=False)
    _add_scale_samples(object_sky if query.get('most') or query.get('ephemeris') else sky)
    return included_json

def render_stream_frame(path, record_json, query_json, scale_json):
    with open(path, 'rb') as stream:
        result, reason = process_fits(stream.read(), json.loads(record_json), json.loads(query_json))
    if result is None:
        raise ValueError(reason or 'Кадр не пройшов повторну перевірку під час рендерингу.')
    frame, sky, object_sky, sky_mask, object_mask = result
    scale = json.loads(scale_json)
    low, high = float(scale['low']), float(scale['high'])
    sky_gray = display_gray(sky, low, high)
    object_gray = display_gray(object_sky, low, high)
    sky_overlay = np.zeros((*sky_mask.shape, 4), dtype=np.uint8)
    object_overlay = np.zeros((*object_mask.shape, 4), dtype=np.uint8)
    sky_overlay[sky_mask] = (255, 153, 88, 160)
    object_overlay[object_mask] = (255, 153, 88, 160)
    return json.dumps({'frame': frame, 'assets': {
        'image': png_uri(sky_gray), 'object_image': png_uri(object_gray),
        'quality_mask_image': png_uri(sky_overlay), 'object_quality_mask_image': png_uri(object_overlay)}},
        ensure_ascii=False, allow_nan=False)

def finish_stream(catalogue_json, frames_json, excluded_json, runtime_json, scale_json):
    catalogue, frames = json.loads(catalogue_json), json.loads(frames_json)
    excluded, runtime, scale = json.loads(excluded_json), json.loads(runtime_json), json.loads(scale_json)
    if len(frames) < 2:
        raise ValueError(f'Після перевірки залишилося кадрів: {len(frames)}. Для часової серії потрібно щонайменше два.')
    frames = sorted(frames, key=lambda item: (item['mjd'], item['id']))
    q = catalogue['query']
    release, survey = q.get('release', 'qr2'), q.get('survey', 'wide')
    collection = f"spherex_{release}" + ("_deep" if survey == 'deep' else '')
    release_label = release.upper() + (' · Deep Survey' if survey == 'deep' else ' · Wide Survey')
    target, ephemeris, most = q.get('target'), q.get('ephemeris'), q.get('most')
    title = f"{most['target_name']} · IRSA MOST" if most else (ephemeris_title(ephemeris) if ephemeris else (f"{target['canonical_name']} · поле ICRS" if target else f"Поле {q['ra']:.4f}°, {q['dec']:+.4f}°"))
    most_source = (f"Пошук рухомої цілі через IRSA MOST SPHEREx; URL і SHA-256 всіх часових частин записані в observation_table_parts. "
                   if len(catalogue.get('observation_table_parts') or []) > 1 else
                   f"Пошук рухомої цілі через IRSA MOST SPHEREx ({most['source_url']}, SHA-256 {most['source_sha256']}). ") if most else ''
    target_description = (f"{most_source}Положення кожного кадру взято з MOST ra_obj/dec_obj; відповідь не надає окремої епохи координати або її невизначеності. Це каталожний збіг, не виявлення SPHEREx. " if most else (ephemeris_description(ephemeris) if ephemeris else (f"Центр поля взято з {target['resolver']} ({target['query_name']}); це каталожні координати, не вимірювання SPHEREx. " if target else '')))
    return {
        'schema_version': 4, 'kind': 'field', 'title': title,
        'description': f"{target_description}SPHEREx {release_label} · D{q['detector']} · {q['start']} — {q['end']}",
        'query': q, 'frames': frames, 'source': 'https://irsa.ipac.caltech.edu/Missions/spherex.html',
        'observation_table_url': catalogue['source_url'], 'observation_table_sha256': catalogue['source_sha256'],
        **({'observation_table_parts': catalogue['observation_table_parts']} if catalogue.get('observation_table_parts') else {}),
        'retrieved_at': catalogue['retrieved_at'], 'processed_at': datetime.now(timezone.utc).isoformat(),
        'attribution': ATTRIBUTION, 'dataset_doi': '10.26131/IRSA678' if release == 'dr1' else '10.26131/IRSA662' if release == 'qr3' else '10.26131/IRSA652', 'method_version': METHOD + '-stream-v1',
        'archive_collection': collection,
        'software': {'astropy': astropy.__version__, 'numpy': np.__version__, 'scipy': scipy.__version__, 'Pillow': PIL.__version__, **runtime},
        'completeness': {'matched_count': catalogue['matched_count'], 'candidate_count': catalogue.get('candidate_count', len(catalogue['records'])), 'selected_count': len(catalogue['records']),
            'processed_count': len(frames), 'catalogue_truncated': catalogue['catalogue_truncated'], 'selection': catalogue['selection'], 'excluded': excluded},
        'display': {'width': 256, 'height': 256, 'sky_fov_deg': q['fov'], 'object_fov_deg': q['fov'],
            'sky_center_ra': q['ra'], 'sky_center_dec': q['dec'], 'projection': 'ICRS TAN', 'orientation': 'North up, East left',
            'resampling': 'bilinear, display only', 'stretch': 'asinh', 'stretch_parameter': 18,
            'low_MJy_sr': scale['low'], 'high_MJy_sr': scale['high'], 'scale_scope': 'same scale for every frame',
            'scale_algorithm': scale['algorithm'], 'scale_subbins_per_exponent': scale['subbins_per_exponent'],
            'scale_sample_count': scale['sample_count'], 'scale_low_interval_MJy_sr': scale['low_interval'],
            'scale_high_interval_MJy_sr': scale['high_interval'], 'psf_matched': False, 'noise_covariance_propagated': False,
            'missing_data_style': '8-pixel checkerboard, grayscale 32/56; not measured signal',
            'bad_pixel_policy': 'Signal retained; overlay marks all FLAGS except SOURCE and FULLSAMPLE plus missing support.'},
        'limits': ['The centre marker is the requested coordinate, not an object detection.',
            'Horizons positions are user-supplied geocentric predictions interpolated on the unit sphere to FITS DATE-AVG; they are not detections and do not use the SPHEREx spacecraft location.',
            'IRSA MOST ra_obj/dec_obj values are service-reported matched positions. The response does not provide a separate coordinate epoch or uncertainty; these are not detections.',
            'Ephemeris interpolation accuracy depends on the supplied Horizons cadence and orbit solution; no position uncertainty is propagated.',
            'Proper-motion positions are a catalogue position propagated linearly from its epoch to FITS DATE-AVG; parallax, radial velocity and catalogue uncertainties are not applied, and they are not detections.',
            'Moving-target view is re-centred at the catalogue coordinate for each exposure; fixed-sky view retains one ICRS centre and can place later target markers outside its field.',
            'WCS roundtrip is a consistency check, not an empirical astrometric accuracy measurement.',
            'No PSF or full spectral response matching; brightness differences do not establish temporal variability.',
            'Wavelength filtering is by approximate central wavelength at the field centre, not full response equivalence.',
            'The 12th and 99.7th percentile display limits for large series are estimated from a bounded exponent histogram; their numerical brackets are recorded in display metadata.',
            'Display PNG assets are content-addressed and held in this browser storage; the passport records their SHA-256 references.',
            'Reprojected PNGs are for display, not quantitative photometry or astrometry.']
    }
