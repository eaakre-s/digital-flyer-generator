/**
 * A hotspot's link when it has no product, in the shape of the Amplience link partial
 * (https://scheels.com/partial/link), so the site and the app read it like any other link.
 * `searchTerm` is the flyer's own addition, used only when nothing more specific is set.
 */

export interface LinkAttribute {
  attributeName: string;
  attributeValue: string;
}

export interface FallbackLink {
  category?: string;
  attributes?: LinkAttribute[];
  onSale?: boolean;
  searchTerm?: string;
  /** A path on scheels.com, or a full URL to another site (a YouTube video, say). */
  urlSlug?: string;
  pageID?: string;
  productID?: string;
  anchor?: string;
  newPage?: boolean;
  useStoreAvailability?: boolean;
  clickID?: string;
}

/** What a link opens, which decides the fields the editor shows for it. */
export type LinkKind = 'products' | 'url' | 'content';

export const isExternalUrl = (url: string) => /^https?:\/\//i.test(url);

/**
 * A typed page path or URL as the site needs it: "stores" → "/stores", "www.youtube.com/watch?v=…"
 * → "https://www.youtube.com/watch?v=…". Anything already starting with "/" or "http" is kept.
 */
export function normalizeUrl(value: string): string {
  if (isExternalUrl(value) || value.startsWith('/')) return value;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(value)) return `https://${value}`;
  return `/${value}`;
}

export const linkKind = (link: FallbackLink): LinkKind => {
  if (link.urlSlug) return 'url';
  if (link.pageID) return 'content';
  return 'products';
};

/** Attribute names the site turns into path segments; others become `?r=` refinements. */
export const PATH_ATTRIBUTES = ['brand', 'gender', 'team', 'promo', 'vendorcollection'];

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * A clean FallbackLink from saved or exported data. Flyers saved before the link partial store
 * `{ type: 'brand' | 'category' | 'search', value }`; those are converted.
 */
export function toFallbackLink(raw: any, label = ''): FallbackLink {
  if (raw && typeof raw.type === 'string' && 'value' in raw) {
    const value = text(raw.value) || text(label);
    if (raw.type === 'brand') return value ? { attributes: [{ attributeName: 'brand', attributeValue: value }] } : {};
    if (raw.type === 'category') return value ? { category: value } : {};
    return value ? { searchTerm: value } : {};
  }
  const link: FallbackLink = {};
  for (const key of ['category', 'searchTerm', 'urlSlug', 'pageID', 'productID', 'anchor', 'clickID'] as const) {
    const value = text(raw?.[key]);
    if (value) link[key] = value;
  }
  if (link.urlSlug) link.urlSlug = normalizeUrl(link.urlSlug);
  for (const key of ['onSale', 'newPage', 'useStoreAvailability'] as const) {
    if (raw?.[key] === true) link[key] = true;
  }
  const attributes = Array.isArray(raw?.attributes)
    ? raw.attributes
        .map((a: any) => ({ attributeName: text(a?.attributeName), attributeValue: text(a?.attributeValue) }))
        .filter((a: LinkAttribute) => a.attributeName && a.attributeValue)
    : [];
  if (attributes.length) link.attributes = attributes;
  return link;
}

/** True when the link points somewhere more specific than a search. */
export const hasTarget = (link: FallbackLink) =>
  !!(link.category || link.attributes?.length || link.urlSlug || link.pageID || link.productID);

export const brandOf = (link: FallbackLink) =>
  link.attributes?.find((a) => a.attributeName.toLowerCase() === 'brand')?.attributeValue ?? '';

// ---------- the site's URL for a link ----------
// Mirrors buildCategoryUrl and LinkContent in customer-scheels amplience-link.tsx, so the preview
// shows what the site will open. Keep the two in step.

const capitalizeWords = (value: string) =>
  value
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

function categoryUrl(link: FallbackLink): string {
  let url = link.category ? `/c/${link.category}/` : '/c/all/';
  const attributes = link.attributes?.length ? link.attributes : undefined;
  if (link.onSale && !attributes) url += 'sale/';
  if (!attributes) return url;

  const find = (name: string) => attributes.find((a) => a.attributeName.toLowerCase() === name);
  const prefix: Record<string, string> = { team: 't/', brand: 'b/', vendorcollection: 'vc/' };
  for (const key of ['gender', 'promo', 'team', 'brand', 'vendorcollection']) {
    const attribute = find(key);
    if (attribute) url += `${prefix[key] ?? ''}${attribute.attributeValue.toLowerCase().replace(/\|/g, '_')}/`;
  }
  if (link.onSale) url += 'sale/';

  const special = ['srule', 'pmin', 'pmax'];
  const lowercase = ['promotionalsale'];
  const refinements: string[] = [];
  for (const a of attributes) {
    const name = a.attributeName.toLowerCase();
    if (PATH_ATTRIBUTES.includes(name) || special.includes(name) || lowercase.includes(name)) continue;
    refinements.push(`${a.attributeName}%3A${capitalizeWords(a.attributeValue).replace(/\|/g, '%7C')}`);
  }
  for (const name of lowercase) {
    const a = find(name);
    if (a) refinements.push(`${a.attributeName}%3A${a.attributeValue}`);
  }
  if (refinements.length) url += `?r=${refinements.join('%3B')}`;
  const params = special.map(find).filter((a): a is LinkAttribute => !!a);
  params.forEach((a, i) => {
    url += `${refinements.length || i > 0 ? '&' : '?'}${a.attributeName}=${a.attributeValue}`;
  });
  return url;
}

/**
 * Where a hotspot's fallback goes: a site path, or a full URL for another site. An empty link
 * searches for the hotspot's label, as the site does.
 */
export function linkPath(link: FallbackLink, label: string): string {
  const target = hasTarget(link) || link.searchTerm ? link : { searchTerm: label };
  if (target.urlSlug && isExternalUrl(target.urlSlug)) return target.urlSlug;
  let url: string;
  if (target.urlSlug) url = target.urlSlug + (target.anchor ? `/#${target.anchor}` : '');
  else if (target.pageID)
    url = (target.pageID === 'deals' ? '/deals' : `/cp/${target.pageID}`) + (target.anchor ? `/#${target.anchor}` : '');
  else if (target.productID && !target.productID.includes('|')) url = `/p/${target.productID}`;
  else if (target.searchTerm && !target.category && !target.attributes?.length && !target.productID)
    url = `/search?q=${encodeURIComponent(target.searchTerm)}`;
  else {
    url = categoryUrl(target);
    // Several product ids (objectIDs joined by |) list just those products.
    if (target.productID?.includes('|')) {
      const param = `objectID%3A${target.productID.split('|').join('%7C')}`;
      url += url.includes('?r=') ? `%3B${param}` : `${url.includes('?') ? '&' : '?'}r=${param}`;
    }
    if (target.anchor) url += `#${target.anchor}`;
  }
  return url.replace(/\/(?=[?#]|$)/, '');
}

/**
 * The site's default text for the panel button of a hotspot with no product, as far as it can be
 * known here (product links name their category once the site has looked it up).
 */
export function defaultButtonText(link: FallbackLink, label: string): string {
  if (link.urlSlug) return /youtube\.com|youtu\.be|vimeo\.com/i.test(link.urlSlug) ? 'Watch the video' : 'Learn more';
  if (link.pageID) return 'View the page';
  if (link.productID) return 'Shop now';
  if (!link.category && !link.attributes?.length) return `Search for ${link.searchTerm || label}`;
  const brand = brandOf(link);
  return brand ? `Shop ${brand} …` : 'Shop …';
}

// ---------- filling a link from Scheels Search ----------

/** The value at least half of `values` share, or '' when none does. */
function shared(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values.filter(Boolean)) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = '';
  let bestCount = 0;
  for (const [v, n] of counts) if (n > bestCount) [best, bestCount] = [v, n];
  return bestCount >= values.length / 2 ? best : '';
}

/**
 * Adds what Scheels Search knows to a link without overwriting anything already set: the category
 * most of the products share (a real category key, like "boots") and, when the link has no brand,
 * the brand most of them share.
 */
export function fillFromProducts(link: FallbackLink, products: { category: string; brand: string }[]): FallbackLink {
  if (!products.length || link.urlSlug || link.pageID || link.productID) return link;
  const next: FallbackLink = { ...link };
  if (!next.category) {
    const category = shared(products.map((p) => p.category));
    if (category) next.category = category;
  }
  if (!brandOf(next)) {
    const brand = shared(products.map((p) => p.brand));
    if (brand) next.attributes = [...(next.attributes ?? []), { attributeName: 'brand', attributeValue: brand }];
  }
  return next;
}
