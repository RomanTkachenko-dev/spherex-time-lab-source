export const SPHEREX_HIPS = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
export const DSS_HIPS = 'https://skies.esac.esa.int/DSSColor';
export function cubeMetadata(properties: Record<string,string>) {
  const depth = Number(properties.hips_cube_depth);
  const wavelengths = properties.data_cube_crval3_arr?.trim().split(/\s+/).map(Number);
  const min = Number(properties.em_min), max = Number(properties.em_max);
  if (properties.dataproduct_type !== 'cube' || depth !== 102 || wavelengths?.length !== depth ||
      !wavelengths.every(v => Number.isFinite(v) && v > 0) || !(min > 0 && max > min)) throw Error('Некоректні метадані спектральної мозаїки.');
  return { depth, wavelengths, min, max };
}
// Aladin 3.8.2 indexes HiPS cube planes uniformly in frequency. This is a
// renderer coordinate, NOT the scientific wavelength of a SPHEREx channel.
// Inversion follows the official IRSA HiPS landing page implementation.
export function cubeRenderFrequency(index:number, meta:ReturnType<typeof cubeMetadata>) {
  if (!Number.isInteger(index) || index < 0 || index >= meta.depth) throw Error('Канал поза мозаїкою.');
  const low = 299792458 / meta.max, high = 299792458 / meta.min;
  return low + (index + .5) / meta.depth * (high - low);
}
