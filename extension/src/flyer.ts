/** Shapes and pure logic for importing a Flyer Studio export into the Digital Flyer `pages` field. */

export interface ImageLink {
  _meta: { schema: string };
  id: string;
  name: string;
  endpoint: string;
  defaultHost: string;
}

export interface Hotspot {
  label: string;
  priceText: string;
  box: { x: number; y: number; w: number; h: number };
  skus: string[];
  objectIds?: string[];
  inStoreOnly?: boolean;
  fallback: { type: 'brand' | 'category' | 'search'; value: string };
  locked: boolean;
  confidence: 'high' | 'low';
}

export interface StudioPage {
  imageName: string;
  hotspots: Hotspot[];
}

export interface StudioFlyer {
  title: string;
  campaign: string;
  startDate: string;
  endDate: string;
  pages: StudioPage[];
}

export interface FlyerPage {
  image?: ImageLink;
  hotspots: Hotspot[];
}

const FALLBACK_TYPES = new Set(['brand', 'category', 'search']);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

// Spreadsheets drop a leading zero when a SKU cell is stored as a number: 4312505020 is SKU 04312505020.
const normalizeSku = (sku: string) => (/^\d{10}$/.test(sku) ? `0${sku}` : sku);

function cleanHotspot(raw: any): Hotspot {
  const box = raw?.box ?? {};
  const x = clamp(Number(box.x) || 0, 0, 100);
  const y = clamp(Number(box.y) || 0, 0, 100);
  const fallbackType = FALLBACK_TYPES.has(raw?.fallback?.type) ? raw.fallback.type : 'search';
  return {
    label: text(raw?.label),
    priceText: text(raw?.priceText),
    box: {
      x: round1(x),
      y: round1(y),
      w: round1(clamp(Number(box.w) || 0, 0, 100 - x)),
      h: round1(clamp(Number(box.h) || 0, 0, 100 - y)),
    },
    skus: Array.isArray(raw?.skus) ? raw.skus.map(text).filter(Boolean).map(normalizeSku) : [],
    objectIds: Array.isArray(raw?.objectIds) ? raw.objectIds.map(text).filter(Boolean) : [],
    inStoreOnly: raw?.inStoreOnly === true,
    fallback: { type: fallbackType, value: text(raw?.fallback?.value) || text(raw?.label) },
    locked: raw?.locked === true,
    confidence: raw?.confidence === 'high' ? 'high' : 'low',
  };
}

/** Reads a Flyer Studio export. Throws an Error whose message tells the author what is wrong with the file. */
export function parseStudioExport(json: string): StudioFlyer {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('This file is not valid JSON. Choose the flyer-<campaign>.json file saved from Flyer Studio.');
  }
  if (!Array.isArray(data?.pages) || !data.pages.length) {
    throw new Error('This file has no pages. Choose the flyer data file saved from Flyer Studio.');
  }
  const pages = data.pages.map((page: any, i: number) => {
    const imageName = text(page?.imageName);
    if (!imageName) throw new Error(`Page ${i + 1} has no image name. Save the flyer data from Flyer Studio again.`);
    return { imageName, hotspots: Array.isArray(page?.hotspots) ? page.hotspots.map(cleanHotspot) : [] };
  });
  return {
    title: text(data.title),
    campaign: text(data.campaign),
    startDate: text(data.startDate),
    endDate: text(data.endDate),
    pages,
  };
}

export interface MediaSettings {
  endpoint: string;
  defaultHost: string;
}

const IMAGE_LINK_SCHEMA = 'http://bigcontent.io/cms/schema/v1/core#/definitions/image-link';

/**
 * Looks up a published image by name and returns its link. The asset UUID that the image-link
 * schema requires comes from the media server's metadata (`metadata.file.id`). `null` when no
 * image with that name is published.
 */
export async function findImage(name: string, media: MediaSettings): Promise<ImageLink | null> {
  try {
    const url = `https://${media.defaultHost}/i/${media.endpoint}/${encodeURIComponent(name)}.json?metadata=true`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const meta = await res.json();
    const id = meta?.metadata?.file?.id;
    if (meta?.status !== 'ok' || typeof id !== 'string') return null;
    return { _meta: { schema: IMAGE_LINK_SCHEMA }, id, name, endpoint: media.endpoint, defaultHost: media.defaultHost };
  } catch {
    return null;
  }
}

/** Pages whose image is not published yet go in without one; the site skips them until a re-import adds it. */
export const buildPages = (flyer: StudioFlyer, images: (ImageLink | null)[]): FlyerPage[] =>
  flyer.pages.map((page, i) => (images[i] ? { image: images[i]!, hotspots: page.hotspots } : { hotspots: page.hotspots }));
