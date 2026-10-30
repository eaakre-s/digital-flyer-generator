/**
 * Checks a saved flyer the way scheels.com will show it, against Scheels Search (the index the site
 * reads): products the site can't show, links that open an empty or missing page, linked products whose
 * names don't look like their box, and pages with no image. Links to a URL or a content page aren't
 * checked, since scheels.com pages can't be loaded from here.
 */

import { searchMany } from './ace';
import { loadCategories } from './categories';
import { facetFilters } from './facets';
import type { FlyerPage, Hotspot } from './flyer';
import { toFallbackLink, type FallbackLink } from './link';

export interface Finding {
  page: number;
  /** The hotspot's index on its page; -1 for the page itself. */
  hotspot: number;
  label: string;
  /** problem: shoppers reach a dead end; check: worth a look. */
  level: 'problem' | 'check';
  message: string;
}

interface Product {
  objectID: string;
  title: string;
  brand: string;
  skus: string[];
}

interface Box {
  p: number;
  h: number;
  hotspot: Hotspot;
  label: string;
}

// Values in one filter, and hits on one page of results: as many as Scheels Search accepts.
const PER_QUERY = 100;
// Boxes linking more products than this are range offers, checked only for their brands.
const MAX_NAMED = 3;
// Variant SKUs are all digits; anything else is a product id (bean).
const SKU_PATTERN = /^\d{8,13}$/;

const quote = (value: string) => `"${value.replace(/"/g, '\\"')}"`;
const named = (values: string[]) => values.map((v) => `“${v}”`).join(', ');
const productIds = (hotspot: Hotspot) => (hotspot.objectIds ?? []).filter(Boolean);
const productSkus = (hotspot: Hotspot) => hotspot.skus.filter(Boolean);

/** Queries finding every product with one of `values` in `field`, a hundred values to a query. */
function lookUpQueries(field: 'objectID' | 'variants.sku', values: string[]) {
  const queries: Record<string, unknown>[] = [];
  for (let i = 0; i < values.length; i += PER_QUERY) {
    queries.push({
      pageSize: PER_QUERY,
      facetFilters: [values.slice(i, i + PER_QUERY).map((v) => `${field}:${quote(v)}`)],
      attributesToRetrieve: ['objectID', 'title', 'brand', 'variants.sku'],
    });
  }
  return queries;
}

function toProduct(hit: any): Product {
  const data = hit?.data ?? {};
  const variants: any[] = Array.isArray(data.variants) ? data.variants : [];
  return {
    objectID: String(data.objectID ?? hit?.id ?? ''),
    title: String(data.title ?? ''),
    brand: String(data.brand ?? ''),
    skus: variants.map((v) => String(v?.sku ?? '')).filter(Boolean),
  };
}

/**
 * Old flyers name some categories by their commercetools slug ("optics-scopes-binoculars") rather than
 * the key listing pages use ("binoculars"). Products carry their primary category's slug and name, so a
 * search for the slug's words finds the name.
 */
const slugQuery = (slug: string) => ({
  query: slug.replace(/-/g, ' '),
  pageSize: 30,
  attributesToRetrieve: ['primaryCategory', 'primaryCategoryName'],
});
const nameForSlug = (result: any, slug: string): string | undefined =>
  (result?.hits ?? []).map((hit: any) => hit?.data ?? {}).find((data: any) => data.primaryCategory === slug)
    ?.primaryCategoryName;

// Words that don't say which product it is.
const FILLER = new Set(['mens', 'womens', 'youth', 'kids', 'and', 'or', 'the', 'with', 'for', 'of', 'in', 'pack']);
const wordsOf = (text: string) =>
  text
    .toLowerCase()
    .replace(/[®™'’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !FILLER.has(w));
// "boot" and "boots", "600" and "600g": a word starting with another counts as the same word.
const sameWord = (a: string, b: string) =>
  a === b || (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a)));

/**
 * Whether a linked product looks like its box: at least half the words of the box's label appear in the
 * product's brand and title. Looser than matching on import, which needs model numbers and prices to
 * agree too, so that only clear mismatches are flagged.
 */
function looksLike(label: string, product: Product) {
  const wanted = wordsOf(label);
  if (wanted.length < 2) return true;
  const have = wordsOf(`${product.brand} ${product.title}`);
  return wanted.filter((w) => have.some((h) => sameWord(w, h))).length >= wanted.length / 2;
}

/** Whether the box's label names the product's brand, by its first word: "Coffee" doesn't name Black Rifle Coffee. */
function namesBrand(label: string, product: Product) {
  const [brand] = wordsOf(product.brand);
  return !!brand && wordsOf(label).some((w) => sameWord(w, brand));
}

/**
 * The linked products that don't look like their box. A range offer ("MEAT! or LEM grinders, stuffers,
 * …") links many products that no one name describes, so only brands are checked, and only when the
 * label names one: "Suppressor Covers" covers every brand.
 */
function unlikeProducts(label: string, products: Product[]): Product[] {
  if (products.length <= MAX_NAMED) return products.filter((product) => !looksLike(label, product));
  if (!products.some((product) => namesBrand(label, product))) return [];
  return products.filter((product) => product.brand && !namesBrand(label, product));
}

/** What a link with no product opens, as the site reads it (its first field set wins). */
function linkTarget(link: FallbackLink) {
  if (link.urlSlug || link.pageID) return { kind: 'page' as const };
  if (link.productID) return { kind: 'product' as const, values: link.productID.split('|').map((v) => v.trim()) };
  if (link.category || link.attributes?.length) return { kind: 'listing' as const };
  // A search: Scheels Search answers every term with something, so there's nothing to check.
  return { kind: 'search' as const };
}

/** Everything found: problems, then things to check, each by page and hotspot. `onProgress` gets a line to show. */
export async function checkFlyer(pages: FlyerPage[], onProgress?: (text: string) => void): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (box: Pick<Box, 'p' | 'h' | 'label'>, level: Finding['level'], message: string) =>
    findings.push({ page: box.p, hotspot: box.h, label: box.label, level, message });

  const boxes: Box[] = [];
  pages.forEach((page, p) => {
    if (!page.image) {
      add(
        { p, h: -1, label: `Page ${p + 1}` },
        'problem',
        'Its image isn’t published, so the site leaves the page out.',
      );
    }
    page.hotspots.forEach((hotspot, h) => {
      const box = { p, h, hotspot, label: hotspot.label.trim() || `Hotspot ${h + 1}` };
      if (!hotspot.label.trim()) add(box, 'check', 'It has no product name, which the site shows as its title.');
      // In-store-only boxes open the store finder.
      if (!hotspot.inStoreOnly) boxes.push(box);
    });
  });
  const withProducts = boxes.filter((b) => productIds(b.hotspot).length || productSkus(b.hotspot).length);
  const withLinks = boxes
    .filter((b) => !withProducts.includes(b))
    .map((b) => {
      const link = toFallbackLink(b.hotspot.fallback, b.hotspot.label);
      return { ...b, link, target: linkTarget(link) };
    });

  // One round of searches: every product (by bean and by SKU) and every category the list doesn't have.
  const categoryNames = new Map((await loadCategories()).map((c) => [c.slug, c.name]));
  const beans = new Set<string>();
  const skus = new Set<string>();
  for (const b of withProducts) {
    productIds(b.hotspot).forEach((id) => beans.add(id));
    productSkus(b.hotspot).forEach((sku) => skus.add(sku));
  }
  const slugs = new Set<string>();
  for (const { link, target } of withLinks) {
    if (target.kind === 'product') target.values.forEach((v) => (SKU_PATTERN.test(v) ? skus : beans).add(v));
    const category = link.category?.toLowerCase();
    if (target.kind === 'listing' && category && !categoryNames.has(category)) slugs.add(category);
  }
  const productQueries = [...lookUpQueries('objectID', [...beans]), ...lookUpQueries('variants.sku', [...skus])];
  const queries = [...productQueries, ...[...slugs].map(slugQuery)];
  onProgress?.('Looking up products…');
  const results = await searchMany(queries, (done) =>
    onProgress?.(`Looking up products… ${done} of ${queries.length}`),
  );
  const products: Product[] = results.slice(0, productQueries.length).flatMap((r) => (r.hits ?? []).map(toProduct));
  const byId = new Map(products.map((product) => [product.objectID.toLowerCase(), product]));
  const bySku = new Map(products.flatMap((product) => product.skus.map((sku) => [sku, product] as const)));
  const slugResults = results.slice(productQueries.length);
  const slugNames = new Map([...slugs].map((slug, i) => [slug, nameForSlug(slugResults[i], slug)]));

  for (const box of withProducts) {
    const ids = productIds(box.hotspot);
    const found = ids.map((id) => byId.get(id.toLowerCase()));
    const online = new Map(
      [...found, ...productSkus(box.hotspot).map((sku) => bySku.get(sku))]
        .filter((product): product is Product => !!product)
        .map((product) => [product.objectID, product]),
    );
    if (!online.size) {
      add(box, 'problem', 'None of its products is on scheels.com, so the site says it’s unavailable online.');
      continue;
    }
    const missing = ids.filter((_, i) => !found[i]);
    if (missing.length) add(box, 'check', `Not on scheels.com, so the site leaves out ${named(missing)}.`);
    const unlike = unlikeProducts(box.hotspot.label, [...online.values()]).map((product) => product.title);
    if (unlike.length) {
      const more = unlike.length > MAX_NAMED ? ` and ${unlike.length - MAX_NAMED} more` : '';
      add(box, 'check', `May not be the product printed: ${named(unlike.slice(0, MAX_NAMED))}${more}.`);
    }
  }

  // Boxes with no product: a product link must open a product; a listing link must name a category
  // and list something.
  const listed: { box: Box; link: FallbackLink; name?: string }[] = [];
  for (const { link, target, ...box } of withLinks) {
    if (target.kind === 'product') {
      const gone = target.values.filter((v) => (SKU_PATTERN.test(v) ? !bySku.has(v) : !byId.has(v.toLowerCase())));
      if (gone.length) add(box, 'problem', `Its link opens a product that isn’t on scheels.com: ${named(gone)}.`);
    }
    if (target.kind !== 'listing') continue;

    const category = link.category?.toLowerCase();
    let name = category ? categoryNames.get(category) : undefined;
    if (category && !name) {
      name = slugNames.get(category);
      if (!name) {
        add(
          box,
          'problem',
          `Its category “${link.category}” isn’t a Scheels category, so its link opens a missing page.`,
        );
        continue;
      }
      add(
        box,
        'check',
        `Its category “${link.category}” is the slug of ${name}, not its key. Pick ${name} in its category field: ` +
          'in the list under the flyer, its link opens a missing page.',
      );
    }
    // The root category lists everything, so it filters nothing.
    listed.push({ box, link: category === 'all' ? { ...link, category: undefined } : link, name });
  }
  const filters = await Promise.all(listed.map(({ link, name }) => facetFilters(link, name)));
  const listings: { box: Box; filters: string[][] }[] = [];
  listed.forEach(({ box, name }, i) => {
    const found = filters[i];
    if (found) listings.push({ box, filters: found });
    else add(box, 'check', `Its products can’t be counted: Scheels Search has no single category named “${name}”.`);
  });
  if (listings.length) {
    onProgress?.('Counting what links list…');
    const counts = await searchMany(
      listings.map(({ filters }) => ({ facetFilters: filters, pageSize: 1, attributesToRetrieve: ['objectID'] })),
    );
    listings.forEach(({ box }, i) => {
      if (!Number(counts[i]?.totalHits ?? 0)) {
        add(box, 'problem', 'Its link lists no products, so it opens an empty page.');
      }
    });
  }

  const rank = (finding: Finding) => (finding.level === 'problem' ? 0 : 1);
  return findings.sort((a, b) => rank(a) - rank(b) || a.page - b.page || a.hotspot - b.hotspot);
}
