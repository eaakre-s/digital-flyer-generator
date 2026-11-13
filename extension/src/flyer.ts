/** Shapes and pure logic for importing a Flyer Studio export into the Digital Flyer `pages` field. */

import { toFallbackLink, type FallbackLink } from './link';

export interface ImageLink {
  _meta: { schema: string };
  id: string;
  name: string;
  endpoint: string;
  defaultHost: string;
}

/** A link at the bottom of the site's product panel, as on a shoppable image. */
export interface PanelLink {
  label: string;
  link: FallbackLink;
  ariaLabel?: string;
  clickId?: string;
}

/** Most links a hotspot's panel takes (the schema's limit). */
export const MAX_PANEL_LINKS = 4;

export interface Hotspot {
  label: string;
  priceText: string;
  box: { x: number; y: number; w: number; h: number };
  skus: string[];
  objectIds?: string[];
  inStoreOnly?: boolean;
  /** Shown under the price in the site's product panel. */
  description?: string;
  /** Replaces the panel button's text. */
  buttonText?: string;
  /** Heading above `links`. */
  linksTitle?: string;
  /** Extra links at the bottom of the site's product panel. */
  links?: PanelLink[];
  fallback: FallbackLink;
  locked: boolean;
  confidence: 'high' | 'low';
  /** Set by Flyer Studio on a box for a whole range, which links to its listing. Used by the import, never saved. */
  wholeRange?: boolean;
}

export interface StudioPage {
  imageName: string;
  hotspots: Hotspot[];
}

export interface FlyerDetails {
  title: string;
  campaign: string;
  startDate: string;
  endDate: string;
}

export interface StudioFlyer extends FlyerDetails {
  pages: StudioPage[];
}

export interface FlyerPage {
  image?: ImageLink;
  hotspots: Hotspot[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

// Spreadsheets drop a leading zero when a SKU cell is stored as a number: 4312505020 is SKU 04312505020.
const normalizeSku = (sku: string) => (/^\d{10}$/.test(sku) ? `0${sku}` : sku);
// Variant SKUs are all digits. Anything else typed into a SKU list is a product id (vendor number + style), which
// is looked up like an item-list style id and swapped for that product's SKU.
const SKU_PATTERN = /^\d{8,13}$/;

function cleanPanelLink(raw: any): PanelLink {
  return {
    label: text(raw?.label),
    link: toFallbackLink(raw?.link),
    ...(text(raw?.ariaLabel) ? { ariaLabel: text(raw?.ariaLabel) } : {}),
    ...(text(raw?.clickId) ? { clickId: text(raw?.clickId) } : {}),
  };
}

function cleanHotspot(raw: any): Hotspot {
  const box = raw?.box ?? {};
  const x = clamp(Number(box.x) || 0, 0, 100);
  const y = clamp(Number(box.y) || 0, 0, 100);
  const entered = Array.isArray(raw?.skus) ? raw.skus.map(text).filter(Boolean).map(normalizeSku) : [];
  const objectIds = Array.isArray(raw?.objectIds) ? raw.objectIds.map(text).filter(Boolean) : [];
  const links = Array.isArray(raw?.links)
    ? raw.links.map(cleanPanelLink).filter((l: PanelLink) => l.label).slice(0, MAX_PANEL_LINKS)
    : [];
  return {
    label: text(raw?.label),
    priceText: text(raw?.priceText),
    box: {
      x: round1(x),
      y: round1(y),
      w: round1(clamp(Number(box.w) || 0, 0, 100 - x)),
      h: round1(clamp(Number(box.h) || 0, 0, 100 - y)),
    },
    skus: entered.filter((v: string) => SKU_PATTERN.test(v)),
    objectIds: [...new Set([...objectIds, ...entered.filter((v: string) => !SKU_PATTERN.test(v))])],
    inStoreOnly: raw?.inStoreOnly === true,
    ...(text(raw?.description) ? { description: text(raw?.description) } : {}),
    ...(text(raw?.buttonText) ? { buttonText: text(raw?.buttonText) } : {}),
    ...(text(raw?.linksTitle) ? { linksTitle: text(raw?.linksTitle) } : {}),
    ...(links.length ? { links } : {}),
    fallback: toFallbackLink(raw?.fallback, text(raw?.label)),
    locked: raw?.locked === true,
    confidence: raw?.confidence === 'high' ? 'high' : 'low',
    ...(raw?.wholeRange === true ? { wholeRange: true } : {}),
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

/**
 * The saved pages in Flyer Studio's export format, so they can go back into Studio (or into another
 * item). Each page is named by its image; a page with no image has none.
 */
export function toStudioExport(details: FlyerDetails, pages: FlyerPage[]): StudioFlyer {
  return {
    ...details,
    pages: pages.map((page) => ({
      imageName: page.image?.name ?? '',
      hotspots: page.hotspots.map((h) => ({ ...h, fallback: toFallbackLink(h.fallback) })),
    })),
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
    // The media server caches "not found" for half an hour, so a name looked up before its image was
    // published would keep failing; a query of its own each time asks the server afresh.
    const path = `https://${media.defaultHost}/i/${media.endpoint}/${encodeURIComponent(name)}.json`;
    const url = `${path}?metadata=true&check=${Date.now()}`;
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

/**
 * A hotspot as the Digital Flyer item stores it, without what only the import uses. Panel links with no
 * label yet are left out: Amplience requires one and would reject the whole flyer.
 */
export function savedHotspot(hotspot: Hotspot): Hotspot {
  const { wholeRange: _importOnly, links, ...saved } = hotspot;
  const kept = (links ?? []).map(cleanPanelLink).filter((l) => l.label);
  return kept.length ? { ...saved, links: kept } : saved;
}

/** Pages whose image is not published yet go in without one; the site skips them until a re-import adds it. */
export const buildPages = (flyer: StudioFlyer, images: (ImageLink | null)[]): FlyerPage[] =>
  flyer.pages.map((page, i) => {
    const hotspots = page.hotspots.map(savedHotspot);
    return images[i] ? { image: images[i]!, hotspots } : { hotspots };
  });
