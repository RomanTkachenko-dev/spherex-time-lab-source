declare const __API_ORIGIN__: string;
declare const __PAGES_BASE__: string;
export const pagesBase = typeof __PAGES_BASE__ === 'string' ? __PAGES_BASE__ : '';
export const staticPages = pagesBase !== '';
export function publicAsset(url: string) {
  return staticPages && /^\/(?:data|vendor|science)\//.test(url) ? pagesBase + url.slice(1) : url;
}

export const apiOrigin = typeof __API_ORIGIN__ === "string" ? __API_ORIGIN__ : "";
export const liveArchive = !staticPages || Boolean(apiOrigin);
export const apiUrl = (path: string) => apiOrigin + path;
