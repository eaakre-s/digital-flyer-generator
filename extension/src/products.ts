import { decide, fetchProducts, findBySkus, searchBatch, searchProducts, type Candidate, type Match, type MatchStatus } from './ace';
import { respellBrands, type BrandSpellings } from './facets';
import type { Hotspot, StudioFlyer } from './flyer';
import { fillFromProducts, linkPath } from './link';

/** One Match per hotspot, indexed [page][hotspot]. */
export type Matches = Match[][];

/**
 * Hotspots that already carry products are confirmed: their SKUs (from the item list, for products it has no
 * bean for) are searched, and their Scheels Search ids are looked up directly. Those ids are beans, or ids built
 * from vendor number + style for items listed without SKUs. A box can carry both, one product by SKU and another
 * by bean, and keeps every product either finds. The rest are found by their printed name, except boxes Flyer
 * Studio marks as covering a whole range, which keep their link to the listing. In-store-only hotspots are left as they are.
 */
export async function matchProducts(flyer: StudioFlyer, onProgress: (done: number, total: number) => void): Promise<Matches> {
  const hotspots = flyer.pages.flatMap((page) => page.hotspots);
  const carries = (h: Hotspot) => h.skus.length > 0 || !!h.objectIds?.length;
  const linked = hotspots.filter((h) => !h.inStoreOnly && carries(h));
  const bySku = linked.filter((h) => h.skus.length);
  const wholeRange = (h: Hotspot) => !h.inStoreOnly && !!h.wholeRange && !carries(h);
  const byName = hotspots.filter((h) => !h.inStoreOnly && !carries(h) && !wholeRange(h));
  const total = linked.length + byName.length;
  const skuResults = await findBySkus(bySku.map((h) => h.skus));
  const idProducts = await fetchProducts([...new Set(linked.flatMap((h) => h.objectIds ?? []))]);
  const byId = new Map(idProducts.map((c) => [c.objectID, c]));
  const skuFound = new Map(bySku.map((h, i) => [h, skuResults[i] ?? []]));
  onProgress(linked.length, total);
  const nameResults = await searchProducts(
    byName.map((h) => h.label),
    (done) => onProgress(linked.length + done, total),
  );
  // Each product once: as its SKUs found it (that names the colour), else as its id did.
  const skuMatch = new Map(
    linked.map((h): [Hotspot, Candidate[]] => {
      const found = [...(skuFound.get(h) ?? []), ...(h.objectIds ?? []).map((id) => byId.get(id)).filter((c): c is Candidate => !!c)];
      return [h, found.filter((c, i) => found.findIndex((x) => x.objectID === c.objectID) === i)];
    }),
  );
  const nameMatch = new Map(byName.map((h, i) => [h, nameResults[i] ?? []]));
  return flyer.pages.map((page) =>
    page.hotspots.map((h): Match => {
      if (h.inStoreOnly) return { status: 'instore', candidates: [], chosen: [] };
      if (wholeRange(h)) return { status: 'range', candidates: [], chosen: [] };
      const found = skuMatch.get(h);
      if (found) {
        return found.length
          ? { status: 'kept', candidates: found, chosen: found.map((c) => c.objectID) }
          : { status: 'offline', candidates: [], chosen: [] };
      }
      return decide(h.label, h.priceText, nameMatch.get(h) ?? []);
    }),
  );
}

/** The products a hotspot's fallback link is filled from: the ticked ones, or else everything found for it. */
const linkSource = (match: Match) => {
  const chosen = match.candidates.filter((c) => match.chosen.includes(c.objectID));
  return chosen.length ? chosen : match.candidates;
};

/** The hotspot's fallback link with the category and brand Scheels Search found filled in where empty. */
export const filledFallback = (hotspot: Hotspot, match: Match) => fillFromProducts(hotspot.fallback, linkSource(match));

/** The fallback link the import saves: filled in from the products found, with brands spelled as Scheels Search spells them. */
const savedFallback = (hotspot: Hotspot, match: Match, spellings?: BrandSpellings) =>
  respellBrands(filledFallback(hotspot, match), spellings);

/**
 * The flyer with each hotspot's products applied as objectIDs (beans), and the fallback link filled in from
 * the products found, its brands spelled as `spellings` says. SKUs are left as they came: the item list's for
 * products it has no bean for, or a person's, pointing at particular colours or sizes.
 */
export function withChosenSkus(flyer: StudioFlyer, matches: Matches, spellings?: BrandSpellings): StudioFlyer {
  return {
    ...flyer,
    pages: flyer.pages.map((page, p) => ({
      ...page,
      hotspots: page.hotspots.map((hotspot, i) => {
        const match = matches[p]?.[i];
        if (!match || match.status === 'instore') return hotspot;
        const h = { ...hotspot, fallback: savedFallback(hotspot, match, spellings) };
        // Unconfirmed style-based ids would open an empty product drawer on the site, so they are dropped.
        const chosen = match.candidates.filter((c) => match.chosen.includes(c.objectID));
        if (match.status === 'offline' && !chosen.length) return { ...h, objectIds: [] };
        return { ...h, objectIds: chosen.map((c) => c.objectID) };
      }),
    })),
  };
}

export function countByStatus(matches: Matches): Record<MatchStatus | 'unresolved', number> {
  const counts = { kept: 0, offline: 0, instore: 0, range: 0, matched: 0, review: 0, none: 0, unresolved: 0 };
  for (const match of matches.flat()) {
    counts[match.status]++;
    if (match.status === 'review' && !match.chosen.length) counts.unresolved++;
  }
  return counts;
}

const STATUS_LABEL: Record<MatchStatus, string> = {
  kept: 'From item list',
  offline: 'Not online yet',
  instore: 'In store only',
  range: 'Whole range',
  matched: 'Matched',
  review: 'Check',
  none: 'Not found',
};

const price = (c: Candidate) => {
  const sale = c.salePrices[0];
  const regular = c.retailPrices[0];
  if (sale === undefined) return '';
  return regular !== undefined && regular !== sale ? `$${sale} (reg. $${regular})` : `$${sale}`;
};

const MORE_PAGE_SIZE = 10;

/** A row's own search: what was searched, how far it has paged, and whether it is busy or done. */
interface RowSearch {
  open: boolean;
  query: string;
  page: number;
  busy: boolean;
  exhausted: boolean;
  error: string;
}
const rowSearches = new WeakMap<Match, RowSearch>();
const rowSearch = (match: Match, label: string): RowSearch => {
  let search = rowSearches.get(match);
  if (!search) {
    search = { open: false, query: label, page: 0, busy: false, exhausted: false, error: '' };
    rowSearches.set(match, search);
  }
  return search;
};

/**
 * Runs a row's search and adds the products found to its candidates, unticked. A new query replaces the
 * unticked candidates (ticked ones stay); `more` fetches the query's next page instead.
 */
async function runRowSearch(match: Match, search: RowSearch, more: boolean, onDone: () => void) {
  const page = more ? search.page + 1 : 1;
  search.busy = true;
  search.error = '';
  onDone();
  try {
    const [found] = await searchBatch([search.query], { page, pageSize: MORE_PAGE_SIZE });
    if (!more) match.candidates = match.candidates.filter((c) => match.chosen.includes(c.objectID));
    const known = new Set(match.candidates.map((c) => c.objectID));
    match.candidates = [...match.candidates, ...found.filter((c) => !known.has(c.objectID))];
    search.page = page;
    search.exhausted = found.length < MORE_PAGE_SIZE;
  } catch (error) {
    search.error = `Scheels Search could not be reached (${(error as Error).message}).`;
  } finally {
    search.busy = false;
    onDone();
  }
}

/** The "Search Scheels" link, its query box when open, and "More results" once a search has run. */
function searchControls(match: Match, label: string, key: string, readOnly: boolean, onChange: () => void) {
  const search = rowSearch(match, label);
  // The list is re-rendered on every change; put focus back on the control that was used.
  const refocus = (id: string) => () => {
    onChange();
    document.getElementById(id)?.focus();
  };
  const wrap = el('div', { className: 'rowsearch' });
  if (!search.open) {
    const open = el('button', { type: 'button', className: 'link', textContent: 'Search Scheels', disabled: readOnly, id: `open-${key}` });
    open.addEventListener('click', () => {
      search.open = true;
      refocus(`q-${key}`)();
    });
    wrap.append(open);
  } else {
    const input = el('input', { type: 'search', value: search.query, id: `q-${key}`, disabled: readOnly }) as HTMLInputElement;
    input.setAttribute('aria-label', `Search Scheels for ${label}`);
    const go = el('button', { type: 'button', textContent: search.busy ? 'Searching…' : 'Search', disabled: readOnly || search.busy, id: `go-${key}` });
    const run = () => {
      search.query = input.value.trim();
      if (search.query) runRowSearch(match, search, false, refocus(`go-${key}`));
    };
    go.addEventListener('click', run);
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        e.preventDefault();
        run();
      }
    });
    wrap.append(input, go);
  }
  if (search.page > 0 || match.candidates.length) {
    const more = el('button', {
      type: 'button',
      className: 'link',
      textContent: search.exhausted ? 'No more results' : 'More results',
      disabled: readOnly || search.busy || search.exhausted,
      id: `more-${key}`,
    });
    more.addEventListener('click', () => runRowSearch(match, search, true, refocus(`more-${key}`)));
    wrap.append(more);
  }
  if (search.error) wrap.append(el('span', { className: 'warn', textContent: search.error }));
  return wrap;
}

// Longer candidate lists get a "Select all" box.
const SELECT_ALL_FROM = 3;

/** Ticks or clears every candidate in a row; shows as part-ticked when only some are. */
function selectAll(match: Match, key: string, readOnly: boolean, onChange: () => void) {
  const ids = match.candidates.map((c) => c.objectID);
  const ticked = ids.filter((id) => match.chosen.includes(id)).length;
  const box = Object.assign(document.createElement('input'), {
    type: 'checkbox',
    id: `all-${key}`,
    checked: ticked === ids.length,
    indeterminate: ticked > 0 && ticked < ids.length,
    disabled: readOnly,
  });
  box.addEventListener('change', () => {
    match.chosen = box.checked ? ids : [];
    onChange();
    document.getElementById(`all-${key}`)?.focus();
  });
  return el('label', { className: 'check selectall' }, box, el('span', { textContent: `Select all ${ids.length}` }));
}

const el = (tag: string, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElement => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
};

/** Renders one row per hotspot (or only those to review), with a checkbox per candidate product. */
export function renderProducts(
  container: HTMLElement,
  flyer: StudioFlyer,
  matches: Matches,
  options: {
    reviewOnly: boolean;
    readOnly: boolean;
    spellings?: BrandSpellings;
    /** The export's number for the first page shown, when only some of its pages are imported. */
    firstPage?: number;
    onChange: () => void;
  },
) {
  container.replaceChildren();
  flyer.pages.forEach((page, p) =>
    page.hotspots.forEach((hotspot, i) => {
      const match = matches[p]?.[i];
      if (!match) return;
      if (options.reviewOnly && !['review', 'none', 'offline'].includes(match.status)) return;

      const row = el('li', { className: `prow ${match.status}` });
      row.append(
        el(
          'div',
          { className: 'phead' },
          el('span', { className: 'muted', textContent: `p.${p + (options.firstPage ?? 1)}` }),
          el('strong', { textContent: hotspot.label || 'Unnamed hotspot' }),
          el('span', { className: 'muted', textContent: hotspot.priceText }),
          el('span', { className: `chip ${match.status}`, textContent: STATUS_LABEL[match.status] }),
        ),
      );

      const showCandidates = match.candidates.length > 0;
      if (match.status === 'instore') {
        row.append(el('p', { className: 'muted', textContent: 'Shown as in store only; no online link.' }));
      } else if (match.status === 'offline' && !showCandidates) {
        row.append(
          el('p', {
            className: 'muted',
            textContent: hotspot.skus.length
              ? `None of its ${hotspot.skus.length} item-list SKUs is on scheels.com yet. Until they are, it links to ${linkPath(savedFallback(hotspot, match, options.spellings), hotspot.label)}.`
              : `Its item-list style was not found on scheels.com. It links to ${linkPath(savedFallback(hotspot, match, options.spellings), hotspot.label)}; search Scheels below if it is online.`,
          }),
        );
      } else if (match.status === 'range' && !showCandidates) {
        row.append(
          el('p', {
            className: 'muted',
            textContent: `Covers a whole range in the item list, so it links to ${linkPath(savedFallback(hotspot, match, options.spellings), hotspot.label)}. Search Scheels below to show particular products instead.`,
          }),
        );
      } else if (match.status === 'none' && !showCandidates) {
        row.append(
          el('p', {
            className: 'muted',
            textContent: `Scheels Search found nothing. This hotspot links to ${linkPath(savedFallback(hotspot, match, options.spellings), hotspot.label)}.`,
          }),
        );
      } else {
        const list = el('ul', { className: 'cands' });
        match.candidates.forEach((candidate) => {
          const box = Object.assign(document.createElement('input'), {
            type: 'checkbox',
            checked: match.chosen.includes(candidate.objectID),
            disabled: options.readOnly,
          });
          box.addEventListener('change', () => {
            match.chosen = box.checked
              ? [...match.chosen, candidate.objectID]
              : match.chosen.filter((id) => id !== candidate.objectID);
            options.onChange();
          });
          const details = [price(candidate), `SKU ${candidate.sku}`, candidate.inStock ? '' : 'out of stock']
            .filter(Boolean)
            .join(' · ');
          list.append(el('li', {}, el('label', {}, box, el('span', { textContent: candidate.title }), el('span', { className: 'muted', textContent: details }))));
        });
        if (match.candidates.length > SELECT_ALL_FROM) row.append(selectAll(match, `${p}-${i}`, options.readOnly, options.onChange));
        row.append(list);
        if (!match.chosen.length) {
          row.append(
            el('p', {
              className: 'muted',
              textContent: `Nothing ticked: this hotspot links to ${linkPath(savedFallback(hotspot, match, options.spellings), hotspot.label)}.`,
            }),
          );
        }
      }
      if (match.status !== 'instore') {
        row.append(searchControls(match, hotspot.label, `${p}-${i}`, options.readOnly, options.onChange));
      }
      container.append(row);
    }),
  );
  if (!container.children.length) {
    container.append(el('li', { className: 'muted', textContent: 'Nothing left to check.' }));
  }
}
