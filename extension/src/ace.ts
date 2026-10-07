/** Product matching against Scheels Search (ACE), the same search scheels.com uses. */

const SEARCH_URL = 'https://search.scheels.com/api/search';
const INDEX = 'commercetools_products';
// ACE rejects more than 8 queries in one request.
const QUERIES_PER_REQUEST = 8;
const REQUESTS_AT_ONCE = 3;
const CANDIDATES = 3;

export interface Candidate {
  objectID: string;
  title: string;
  brand: string;
  /** The variant SKU commercetools and the site's /p/{sku} pages use. */
  sku: string;
  salePrices: number[];
  retailPrices: number[];
  inStock: boolean;
}

/**
 * kept: SKUs came with the hotspot and some are online (candidates are those products, all chosen).
 * offline: SKUs came with the hotspot but none is online yet. instore: in-store-only, not matched.
 * matched / review / none: found by name search, automatically, needing a check, or not at all.
 */
export type MatchStatus = 'kept' | 'offline' | 'instore' | 'matched' | 'review' | 'none';

export interface Match {
  status: MatchStatus;
  candidates: Candidate[];
  /** objectIDs of the chosen candidates; empty means "no product, use the fallback link". */
  chosen: string[];
}

const money = (v: unknown) => (typeof v === 'number' && v > 0 ? Math.round(v * 100) / 100 : null);

function toCandidate(hit: any): Candidate | null {
  const data = hit?.data ?? hit;
  const sku = data?.primarySKU || data?.variants?.[0]?.sku;
  if (!data?.objectID || !sku) return null;
  const prices = data.pricing?.groups?.default ?? data.pricing ?? {};
  return {
    objectID: String(data.objectID),
    title: String(data.title ?? ''),
    brand: String(data.brand ?? ''),
    sku: String(sku),
    salePrices: [prices.minSale, prices.maxSale].map(money).filter((v): v is number => v !== null),
    retailPrices: [prices.minRetail, prices.maxRetail].map(money).filter((v): v is number => v !== null),
    inStock: data.inStock === true,
  };
}

export async function searchBatch(batch: string[]): Promise<Candidate[][]> {
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      queries: batch.map((query) => ({
        indexName: INDEX,
        branchName: 'search',
        query,
        page: 1,
        pageSize: CANDIDATES,
        trackEvents: false,
        dynamicRerank: false,
      })),
    }),
  });
  if (!res.ok) throw new Error(`Scheels Search answered ${res.status}.`);
  const data = await res.json();
  return batch.map((_, j) => {
    const hits: unknown[] = data?.results?.[j]?.hits ?? [];
    return hits.map(toCandidate).filter((c): c is Candidate => c !== null);
  });
}

/** Top candidates for each query, in order. `onProgress` gets the number of queries answered so far. */
export async function searchProducts(queries: string[], onProgress?: (done: number) => void): Promise<Candidate[][]> {
  const batches: string[][] = [];
  for (let i = 0; i < queries.length; i += QUERIES_PER_REQUEST) batches.push(queries.slice(i, i + QUERIES_PER_REQUEST));
  const results: Candidate[][][] = new Array(batches.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < batches.length) {
      const b = next++;
      results[b] = await searchBatch(batches[b]);
      done += batches[b].length;
      onProgress?.(done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(REQUESTS_AT_ONCE, batches.length) }, worker));
  return results.flat();
}

/**
 * The online products carrying any of each hotspot's SKUs (from the item list), one ACE filter query per
 * hotspot. An empty list means none of its SKUs is on scheels.com yet.
 */
export async function findBySkus(skuLists: string[][]): Promise<Candidate[][]> {
  const results: Candidate[][] = [];
  for (let i = 0; i < skuLists.length; i += QUERIES_PER_REQUEST) {
    const batch = skuLists.slice(i, i + QUERIES_PER_REQUEST);
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queries: batch.map((skus) => ({
          indexName: INDEX,
          branchName: 'search',
          query: '',
          filters: skus
            .filter((sku) => /^\d{8,13}$/.test(sku))
            .slice(0, 40)
            .map((sku) => `variants.sku:"${sku}"`)
            .join(' OR '),
          page: 1,
          pageSize: 10,
          trackEvents: false,
          dynamicRerank: false,
        })),
      }),
    });
    if (!res.ok) throw new Error(`Scheels Search answered ${res.status}.`);
    const data = await res.json();
    batch.forEach((_, j) => {
      const hits: unknown[] = data?.results?.[j]?.hits ?? [];
      results.push(hits.map(toCandidate).filter((c): c is Candidate => c !== null));
    });
  }
  return results;
}

/** Products by objectID, for showing what a hotspot is already linked to. Unknown ids are left out. */
export async function fetchProducts(objectIds: string[]): Promise<Candidate[]> {
  if (!objectIds.length) return [];
  const res = await fetch('https://search.scheels.com/api/indexes/commercetools_products/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: objectIds }),
  });
  if (!res.ok) throw new Error(`Scheels Search answered ${res.status}.`);
  const data = await res.json();
  const documents: any[] = Array.isArray(data?.documents) ? data.documents : [];
  return documents
    .filter((doc) => doc?.data)
    .map((doc) => toCandidate({ data: { ...doc.data, objectID: doc.id } }))
    .filter((c): c is Candidate => c !== null);
}

/** Dollar amounts printed in a price line: "Now $2,199.97 · Reg. $3,499.97" → [2199.97, 3499.97]. */
export function printedPrices(priceText: string): number[] {
  return [...priceText.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1].replace(/,/g, '')));
}

const samePrice = (a: number, b: number) => Math.abs(a - b) < 0.01;
const words = (text: string) => text.toLowerCase().replace(/[®™'’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
const GENERIC = new Set(['mens', 'womens', 'youth', 'kids', 'and', 'or', 'the', 'with', 'for']);

/**
 * The printed name must point at this product: every model token (one containing a digit, like
 * "XQ50" or "3") appears in its title; with no model tokens, at least half of the other words do.
 */
function nameMatches(label: string, title: string): boolean {
  const titleWords = new Set(words(title));
  const labelWords = words(label).filter((w) => !GENERIC.has(w));
  const models = labelWords.filter((w) => /\d/.test(w));
  if (models.length) return models.every((w) => titleWords.has(w));
  const plain = labelWords.filter((w) => w.length >= 3);
  return plain.length > 0 && plain.filter((w) => titleWords.has(w)).length >= plain.length / 2;
}

/**
 * A candidate is accepted automatically when its brand appears in the printed product name, the
 * names agree (see nameMatches), and one of the printed prices equals its sale price (or, for "Save 40% · Reg. $64.99" offers that
 * print no sale price, its regular price). Everything else goes to review.
 */
export function isConfident(label: string, priceText: string, candidate: Candidate): boolean {
  const brand = candidate.brand.trim().toLowerCase();
  if (!brand || !label.toLowerCase().includes(brand) || !nameMatches(label, candidate.title)) return false;
  const printed = printedPrices(priceText);
  if (printed.some((p) => candidate.salePrices.some((s) => samePrice(p, s)))) return true;
  const printsOnlyRegular = printed.length > 0 && /reg/i.test(priceText) && !/now|sale|final/i.test(priceText);
  return printsOnlyRegular && printed.some((p) => candidate.retailPrices.some((r) => samePrice(p, r)));
}

export function decide(label: string, priceText: string, candidates: Candidate[]): Match {
  if (!candidates.length) return { status: 'none', candidates, chosen: [] };
  const confident = candidates.filter((c) => isConfident(label, priceText, c));
  return confident.length
    ? { status: 'matched', candidates, chosen: confident.map((c) => c.objectID) }
    : { status: 'review', candidates, chosen: [] };
}
