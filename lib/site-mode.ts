declare const __PAGES_BASE__: string;
export const pagesBase = typeof __PAGES_BASE__ === 'string' ? __PAGES_BASE__ : '';
export const staticPages = pagesBase !== '';
export function publicAsset(url: string) {
  return staticPages && /^\/(?:data|vendor)\//.test(url) ? pagesBase + url.slice(1) : url;
}
