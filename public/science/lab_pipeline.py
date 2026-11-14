"""Point-source research laboratory. Fits native pixels, never display PNGs.

Conditional errors assume independent VARIANCE pixels and a correct fixed ePSF.
Calibration/model systematics are not included. No discovery claims are made.
"""
from io import BytesIO
from hashlib import sha256
import json
import numpy as np
from scipy.interpolate import RectBivariateSpline
from scipy.optimize import least_squares
from scipy.ndimage import maximum_filter, median_filter
from scipy.spatial import cKDTree
from scipy.integrate import trapezoid
from astropy.io import fits
from astropy.wcs import WCS
from astropy.coordinates import SkyCoord
from astropy import units as u

METHOD = 'native-epsf-laboratory-1.2'
BAD_MASK = np.uint32(0xffffffff ^ ((1 << 21) | (1 << 12)))
CAL = {}
TILES = {}

def load_calibration(detector, raw):
    with np.load(BytesIO(raw), allow_pickle=False) as a:
        CAL[int(detector)] = {k: a[k].copy() for k in a.files}

def required_tiles(raw):
    with fits.open(BytesIO(raw), memmap=False) as h:
        header=h['IMAGE'].header
        height,width=h['IMAGE'].data.shape
        x0=1-float(header['CRPIX1A']); y0=1-float(header['CRPIX2A'])
        return [f'{tx}-{ty}' for ty in range(max(0,int(y0)//512),min(3,int(y0+height-1)//512)+1)
                for tx in range(max(0,int(x0)//512),min(3,int(x0+width-1)//512)+1)]

def load_tile(key, raw):
    with np.load(BytesIO(raw), allow_pickle=False) as a: TILES[key]={k:a[k].copy() for k in a.files}

def epsf_renderer(epsf, oversampling):
    """Pixel-convolved ePSF: evaluate at native pixel centres, no second integration."""
    sy, sx = oversampling
    if not np.isfinite(epsf).all() or epsf.ndim != 2 or min(sx, sy) <= 0:
        raise ValueError('Invalid ePSF calibration')
    yy = (np.arange(epsf.shape[0])-(epsf.shape[0]-1)/2)/sy
    xx = (np.arange(epsf.shape[1])-(epsf.shape[1]-1)/2)/sx
    spline = RectBivariateSpline(yy, xx, epsf, kx=3, ky=3, s=0)
    def render(x, y, x0, y0):
        dx, dy = x-x0, y-y0
        p = spline.ev(dy.ravel(), dx.ravel()).reshape(x.shape)
        p[(dx < xx[0]) | (dx > xx[-1]) | (dy < yy[0]) | (dy > yy[-1])] = 0
        # Normalise on the complete native phase grid, not on surviving pixels.
        gy, gx = np.mgrid[-5:6, -5:6].astype(float)
        gx += np.floor(x0); gy += np.floor(y0)
        qx, qy = gx-x0, gy-y0
        q = spline.ev(qy.ravel(), qx.ravel()).reshape(gx.shape)
        q[(qx < xx[0]) | (qx > xx[-1]) | (qy < yy[0]) | (qy > yy[-1])] = 0
        norm = q.sum()
        if not np.isfinite(norm) or norm <= 0: raise ValueError('Invalid ePSF normalization')
        return p/norm
    return render

def fit_source(image, variance, valid, x0, y0, epsf, oversampling, fit_position=True, neighbours=()):
    """Weighted ePSF + planar background, with optional bounded centroid fit."""
    ix, iy = int(np.floor(x0)), int(np.floor(y0))
    if ix < 5 or iy < 5 or ix+5 >= image.shape[1] or iy+5 >= image.shape[0]:
        raise ValueError('Потрібна повна ділянка 11×11 нативних пікселів навколо цілі.')
    ys, xs = slice(iy-5, iy+6), slice(ix-5, ix+6)
    yy, xx = np.mgrid[iy-5:iy+6, ix-5:ix+6].astype(float)
    good = valid[ys, xs]
    if good.sum() < 50: raise ValueError('Недостатньо придатних пікселів для моделі та фону.')
    render = epsf_renderer(epsf, oversampling)
    p = render(xx, yy, x0, y0)
    if p[good].sum() < 0.8: raise ValueError('FLAGS або пропуски перекривають понад 20% моделі джерела.')
    d = image[ys, xs][good]; sigma = np.sqrt(variance[ys, xs][good])
    bx, by = (xx-x0)/5, (yy-y0)/5
    # Nearby candidates have separate amplitudes, fitted jointly with the background.
    nuisance = [render(xx, yy, nx, ny)[good] for nx, ny in neighbours
                if 1.5 < np.hypot(nx-x0, ny-y0) <= 6]
    design = np.column_stack([p[good], np.ones(len(d)), bx[good], by[good], *nuisance])
    linear_count = design.shape[1]
    initial, _, rank, _ = np.linalg.lstsq(design/sigma[:, None], d/sigma, rcond=None)
    if rank < linear_count: raise ValueError('Вироджена модель фону.')
    def residual(v):
        px, py = (v[-2], v[-1]) if fit_position else (x0, y0)
        model = v[0]*render(xx, yy, px, py)+v[1]+v[2]*bx+v[3]*by
        nuisance_signal = design[:, 4:] @ v[4:linear_count]
        return (model[good]+nuisance_signal-d)/sigma
    start = np.r_[initial, x0, y0] if fit_position else initial
    low = [-np.inf]*linear_count + ([x0-1.5, y0-1.5] if fit_position else [])
    high = [np.inf]*linear_count + ([x0+1.5, y0+1.5] if fit_position else [])
    fit = least_squares(residual, start, bounds=(low, high), x_scale='jac', max_nfev=120)
    if not fit.success or np.linalg.matrix_rank(fit.jac) < len(start):
        raise ValueError('Підгонка ePSF не збіглася або не визначає похибки.')
    if fit_position and np.any(np.abs(fit.x[-2:]-[x0, y0]) > 1.49):
        raise ValueError('Центр досяг межі пошуку; потрібні кращі початкові координати.')
    cov = np.linalg.inv(fit.jac.T @ fit.jac)
    dof = len(d)-len(start)
    reduced = float(np.dot(fit.fun, fit.fun)/dof)
    # Never shrink archive uncertainties; empirical excess scatter inflates them.
    cov *= max(1., reduced)
    px, py = fit.x[-2:] if fit_position else (x0, y0)
    if render(xx, yy, px, py)[good].sum() < 0.8:
        raise ValueError('У підігнаній позиції недостатня підтримка ePSF.')
    return {'amplitude': float(fit.x[0]), 'error': float(np.sqrt(cov[0, 0])),
            'x': float(px), 'y': float(py), 'reduced_chi2': reduced, 'dof': dof,
            'position_covariance_pixel2': cov[-2:, -2:].tolist() if fit_position else None,
            'background': float(fit.x[1]), 'used_pixels': int(good.sum()), 'neighbours_fitted': len(nuisance)}

def calibrate_position(cal, header, x, y):
    # FITS cutout alternate WCS refers to the full detector. No guessed offsets.
    ox, oy = 1+x-float(header['CRPIX1A']), 1+y-float(header['CRPIX2A'])
    xi, yi = int(round(ox)), int(round(oy))
    if not (0 <= xi < 2040 and 0 <= yi < 2040): raise ValueError('Позиція поза картою калібрації.')
    zone = int(np.argmin((cal['xc']-ox)**2+(cal['yc']-oy)**2))
    if 'channel' in cal:  # small independent synthetic test calibrations
        tile, tx, ty = cal, xi, yi
    else:
        tile=TILES[f'{int(header["DETECTOR"])}:{xi//512}-{yi//512}'];tx,ty=xi%512,yi%512
    channel = int(tile['channel'][ty, tx])
    wave, width = float(tile['wave'][ty, tx]), float(tile['width'][ty, tx])
    if not (np.isfinite(wave) and np.isfinite(width) and wave > 0 and width > 0):
        raise ValueError('Немає скінченної спектральної калібрації.')
    return zone, channel, wave, width

def measure_at(image, variance, valid, wcs, header, cal, x, y, fit_position, neighbours=()):
    zone, _, _, _ = calibrate_position(cal, header, x, y)
    fit = fit_source(image, variance, valid, x, y, cal['epsf'][zone], cal['oversampling'], fit_position, neighbours)
    zone2, channel, wave, width = calibrate_position(cal, header, fit['x'], fit['y'])
    if zone2 != zone:
        fit = fit_source(image, variance, valid, x, y, cal['epsf'][zone2], cal['oversampling'], fit_position, neighbours)
        zone = zone2
        if calibrate_position(cal, header, fit['x'], fit['y'])[0] != zone:
            raise ValueError('Нестійка позиція на межі зон ePSF.')
        _, channel, wave, width = calibrate_position(cal, header, fit['x'], fit['y'])
    ra, dec = wcs.all_pix2world(fit['x'], fit['y'], 0)
    center = SkyCoord(ra*u.deg, dec*u.deg)
    # Local spherical Jacobian contains the native WCS/SIP pixel area.
    step = 1e-3
    rr, dd = wcs.all_pix2world([fit['x']+step, fit['x']], [fit['y'], fit['y']+step], 0)
    east, north = center.spherical_offsets_to(SkyCoord(rr*u.deg, dd*u.deg))
    jac = np.array([east.arcsec, north.arcsec])/step
    solid_angle = abs(np.linalg.det(jac))*(np.pi/(180*3600))**2
    factor = 1e12*solid_angle  # MJy/sr -> microJy using local native pixel area
    pcov = fit.pop('position_covariance_pixel2')
    skycov = (jac @ np.asarray(pcov) @ jac.T).tolist() if pcov is not None else None
    snr = fit['amplitude']/fit['error']
    return {**fit, 'ra': float(ra), 'dec': float(dec), 'flux_uJy': fit['amplitude']*factor,
            'flux_error_uJy': fit['error']*factor, 'snr': float(snr),
            'position_covariance_arcsec2': skycov, 'pixel_solid_angle_sr': float(solid_angle),
            'epsf_zone': zone, 'channel_local': channel, 'wavelength_um': wave, 'bandwidth_um': width,
            'centroid_fitted': bool(fit_position),
            'quality_ok': bool(fit['reduced_chi2'] <= 3 and (not fit_position or snr >= 5))}

def detect_sources(image, variance, valid, wcs, header, cal, threshold, max_sources, diagnostics=None):
    fill = np.median(image[valid]) if valid.any() else 0.
    background = median_filter(np.where(valid, image, fill), size=11, mode='nearest')
    residual = np.where(valid, image-background, 0.)
    # A local empirical scale suppresses peaks in structured background.
    mad = 1.4826 * median_filter(np.abs(residual), size=11, mode='nearest')
    noise = np.maximum(np.sqrt(np.where(valid, variance, 1)), mad)
    snr = np.where(valid, residual/noise, -np.inf)
    peaks = (snr == maximum_filter(snr, size=3, mode='constant', cval=-np.inf)) & (snr >= threshold)
    peaks[:5] = False; peaks[-5:] = False; peaks[:, :5] = False; peaks[:, -5:] = False
    ys, xs = np.where(peaks)
    order = np.argsort(-snr[ys, xs], kind='stable')
    coordinates = np.column_stack([xs, ys])
    tree = cKDTree(coordinates) if len(coordinates) else None
    if diagnostics is not None:
        diagnostics.update(total_peaks=len(order), attempted_peaks=min(len(order), max_sources),
                           skipped_peaks=max(0, len(order)-max_sources), duplicates=0,
                           rejected_quality=0, rejected_fit=0)
    detections, rejected = [], 0
    for i in order[:max_sources]:
        neighbours = coordinates[tree.query_ball_point(coordinates[i], 6)]
        # Bound the nuisance model and choose closest distinct peak positions.
        distances = np.linalg.norm(neighbours-coordinates[i], axis=1)
        nearby = neighbours[np.argsort(distances, kind='stable')][1:9]
        try:
            result = measure_at(image, variance, valid, wcs, header, cal,
                                float(xs[i]), float(ys[i]), True, nearby)
            if result['quality_ok'] and result['snr'] >= threshold:
                if all(np.hypot(result['x']-d['x'], result['y']-d['y']) > 1 for d in detections):
                    detections.append(result)
                elif diagnostics is not None:
                    diagnostics['duplicates'] += 1
            else:
                rejected += 1
                if diagnostics is not None: diagnostics['rejected_quality'] += 1
        except (ValueError, np.linalg.LinAlgError):
            rejected += 1
            if diagnostics is not None: diagnostics['rejected_fit'] += 1
    return detections, int(len(order)), rejected

def analyze_fits(raw, record, options):
    with fits.open(BytesIO(raw), memmap=False) as h:
        hdr = h['IMAGE'].header
        detector = int(hdr['DETECTOR'])
        if str(hdr['OBSID']) != record['observation'] or detector != int(record['detector']):
            raise ValueError('Ідентичність FITS не відповідає каталогу.')
        if hdr.get('TIMESYS', '').upper() != 'UTC': raise ValueError('Очікується UTC.')
        if detector not in CAL: raise ValueError('Калібрація детектора не завантажена.')
        digest = sha256(raw).hexdigest()
        if record.get('expected_sha256') and digest != record['expected_sha256']:
            raise ValueError('FITS змінився відносно збереженої серії.')
        image = h['IMAGE'].data.astype(float)*u.Unit(hdr['BUNIT']).to(u.MJy/u.sr)
        vh = h['VARIANCE']
        variance = vh.data.astype(float)*u.Unit(vh.header['BUNIT']).to((u.MJy/u.sr)**2)
        flags = h['FLAGS'].data.astype(np.uint32)
        if image.shape != variance.shape or image.shape != flags.shape: raise ValueError('Неузгоджені масиви FITS.')
        valid = np.isfinite(image) & np.isfinite(variance) & (variance > 0) & ((flags & BAD_MASK) == 0)
        wcs, cal = WCS(hdr), dict(CAL[detector])
        epsf_source = 'packaged-QR3-ePSF-for-legacy-FITS'
        if 'EPSF' in h:
            e = h['EPSF']
            if e.header.get('DETCOORD', '').strip() != 'sky' or int(e.header['DETECTOR']) != detector:
                raise ValueError('Непідтримувана система координат ePSF у FITS.')
            cal.update(epsf=e.data['EPSF'].copy(), xc=e.data['XCENTER'].copy(), yc=e.data['YCENTER'].copy(),
                       oversampling=np.array([e.header['OVSMPY'], e.header['OVSMPX']]))
            epsf_source = 'native-FITS-EPSF'
        elif 'dr1' in record['release']:
            raise ValueError('DR1 не містить очікуваного розширення EPSF; інша калібрація не підставляється.')
        target, target_error = None, None
        try:
            x, y = [float(v) for v in wcs.all_world2pix(record['ra'], record['dec'], 0)]
            if not np.isfinite([x, y]).all(): raise ValueError('Ціль поза WCS.')
            target = measure_at(image, variance, valid, wcs, hdr, cal, x, y, options['fit_position'])
        except (ValueError, KeyError) as e: target_error = str(e)
        detections, peak_count, rejected, detection_error = [], 0, 0, None
        detection_diagnostics = {}
        if options['detect']:
            try: detections, peak_count, rejected = detect_sources(image, variance, valid, wcs, hdr, cal, options['snr'], options['max_sources'], detection_diagnostics)
            except ValueError as e: detection_error = str(e)
        return {'id': record['id'], 'observation': record['observation'], 'detector': detector,
                'mjd': float(hdr['MJD-AVG']), 'date': str(hdr['DATE-AVG']), 'release': record['release'],
                'source_url': record['url'], 'cutout_url': record['cutout_url'], 'sha256': digest,
                'target': target, 'target_error': target_error, 'detections': detections,
                'peak_count': peak_count, 'rejected_peaks': rejected, 'detection_error': detection_error,
                'epsf_source': epsf_source, 'detection_diagnostics': detection_diagnostics}

def response_curve(point, detector):
    cal = CAL[detector]; ch = point['channel_local']
    if not 1 <= ch <= 17: return None
    # Laboratory middle-pixel fiducial, shifted to the measured band centre.
    # This approximation is explicitly reported, never called a measured per-pixel response.
    wave = cal[f'lambda_{ch}']; transmission = cal[f'response_{ch}']
    centre = float(cal[f'centre_{ch}'])
    return wave + point['wavelength_um']-centre, transmission

def response_distance(curve_a, curve_b):
    if curve_a is None or curve_b is None: return None
    xa, ya = curve_a; xb, yb = curve_b
    grid = np.unique(np.r_[xa, xb])
    a = np.interp(grid, xa, ya, left=0, right=0); b = np.interp(grid, xb, yb, left=0, right=0)
    aa, bb = trapezoid(a, grid), trapezoid(b, grid)
    if min(aa, bb) <= 0: return None
    return float(trapezoid(np.abs(a/aa-b/bb), grid)/2)

def spectral_summary(frames, tolerance):
    bins = []
    for detector in range(1, 7):
        for channel in range(1, 18):
            rows = [f for f in frames if f['detector'] == detector and f['target'] and
                    f['target']['channel_local'] == channel and f['target']['quality_ok']]
            item = {'channel': (detector-1)*17+channel, 'detector': detector, 'local': channel,
                    'count': len(rows), 'reference': None, 'comparisons': [], 'weighted_flux_uJy': None,
                    'error_uJy': None, 'chi2': None, 'dof': 0, 'response': None}
            if rows:
                # Time-first reference avoids choosing by noise/SNR.
                rows.sort(key=lambda f: (f['mjd'], f['id']))
                ref = rows[0]; curve = response_curve(ref['target'], detector)
                if curve is not None: item['response'] = {'wavelength_um': curve[0].tolist(), 'transmission': curve[1].tolist()}
                accepted = []
                for row in rows:
                    distance = response_distance(curve, response_curve(row['target'], detector))
                    compatible = row['release'] == ref['release'] and distance is not None and distance <= tolerance
                    item['comparisons'].append({'id': row['id'], 'distance': distance, 'compatible': compatible})
                    if compatible: accepted.append(row['target'])
                item['reference'] = ref['id']
                if accepted:
                    flux = np.array([p['flux_uJy'] for p in accepted]); errors = np.array([p['flux_error_uJy'] for p in accepted])
                    weights = errors**-2; mean = float(np.dot(flux, weights)/weights.sum())
                    item.update(weighted_flux_uJy=mean, error_uJy=float(1/np.sqrt(weights.sum())),
                                chi2=float(np.sum(((flux-mean)/errors)**2)), dof=len(accepted)-1)
            bins.append(item)
    return bins

def link_tracks(frames, options):
    """Constant angular velocity hypotheses in a local spherical offset frame.

    Greedy disjoint hypothesis selection; this is not an orbital solution or
    catalogue novelty test. Explicit work caps fail rather than truncate.
    """
    rows = []
    origin = SkyCoord(options['ra']*u.deg, options['dec']*u.deg)
    for fi, frame in enumerate(frames):
        for di, point in enumerate(frame['detections']):
            offset = SkyCoord(point['ra']*u.deg, point['dec']*u.deg).transform_to(origin.skyoffset_frame())
            rows.append({'frame': fi, 'detection': di, 'id': f"{frame['id']}:{di}", 't': frame['mjd'],
                         'x': float(offset.lon.arcsec), 'y': float(offset.lat.arcsec), 'snr': point['snr']})
    if len(rows) > 3000: raise ValueError('Понад 3000 детекцій для зв’язування. Звузьте період або поле.')
    groups = {}
    for i, row in enumerate(rows): groups.setdefault(row['t'], []).append(i)
    times = sorted(groups)
    if len(times) < 3: return []
    xy = np.array([[r['x'], r['y']] for r in rows]); tt = np.array([r['t'] for r in rows])
    trees = {t: cKDTree(xy[groups[t]]) for t in times}
    hypotheses = {}; tested = 0
    radius, max_speed, max_gap = options['radius_arcsec'], options['max_speed_arcsec_day'], options['max_gap_days']
    for ta_i, ta in enumerate(times):
        for tb in times[ta_i+1:]:
            dt = tb-ta
            if dt > max_gap: break
            for ia in groups[ta]:
                for local_b in trees[tb].query_ball_point(xy[ia], max_speed*dt+radius):
                    ib = groups[tb][local_b]; velocity = (xy[ib]-xy[ia])/dt
                    tested += 1
                    if tested > 20000: raise ValueError('Понад 20000 гіпотез траєкторій. Звузьте параметри руху.')
                    selected = [ia, ib]
                    for tc in times:
                        if tc in (ta, tb) or tc < ta or tc-ta > max_gap: continue
                        distance, local = trees[tc].query(xy[ia]+velocity*(tc-ta))
                        if distance <= radius: selected.append(groups[tc][int(local)])
                    selected = sorted(set(selected), key=lambda k: (tt[k], rows[k]['id']))
                    if len(selected) < 3: continue
                    t = tt[selected]-tt[selected[0]]; design = np.column_stack([np.ones(len(t)), t])
                    coeff, _, _, _ = np.linalg.lstsq(design, xy[selected], rcond=None)
                    residual = np.linalg.norm(xy[selected]-design@coeff, axis=1)
                    speed = float(np.linalg.norm(coeff[1]))
                    if residual.max() > radius or speed > max_speed: continue
                    key = tuple(selected)
                    hypotheses[key] = {'detections': [rows[k] for k in selected], 'count': len(selected),
                        'rms_arcsec': float(np.sqrt(np.mean(residual**2))), 'speed_arcsec_day': speed,
                        'velocity_east_north_arcsec_day': coeff[1].tolist(), 'span_days': float(t[-1]),
                        'motion_resolved': bool(speed*t[-1] > 2*radius), 'catalogue_status': 'not-crossmatched'}
    ordered = sorted(hypotheses.values(), key=lambda h: (-h['count'], h['rms_arcsec'], -h['span_days']))
    used = set(); result = []
    for hypothesis in ordered:
        ids = {r['id'] for r in hypothesis['detections']}
        if ids & used: continue
        used |= ids; result.append(hypothesis)
    return result

def finish_lab(frames, options):
    frames = sorted(frames, key=lambda f: (f['mjd'], f['id']))
    tracks, tracking_error = [], None
    if options['detect']:
        try: tracks = link_tracks(frames, options)
        except ValueError as e: tracking_error = str(e)
    return {'schema_version': 1, 'method': METHOD, 'frames': frames,
            'channels': spectral_summary(frames, options['response_tolerance']),
            'tracks': tracks, 'tracking_error': tracking_error,
            'options': options, 'error_model': 'conditional diagonal VARIANCE, inflated by max(1,reduced chi2)',
            'response_model': 'laboratory middle-pixel fiducial shifted to calibrated pixel band centre',
            'limits': ['Point-source model; the detector fits fixed-position nearby nuisance sources. No extended-source photometry.',
                       'Flux and centroid uncertainties exclude calibration, ePSF, WCS and pixel covariance systematics.',
                       'Spectral matches are conditional on shifted fiducial response approximation, not exact per-pixel throughput.',
                       'Spectral points at different wavelengths may have different epochs; averages assume stationarity.',
                       'Tracks use constant angular velocity, not orbits. Catalogue novelty has not been established.',
                       'Peak SNR threshold is not a false-discovery probability. Ranking is by support count, residual and span.']}
