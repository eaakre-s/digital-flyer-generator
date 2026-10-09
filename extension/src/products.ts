import { decide, fetchProducts, findBySkus, searchBatch, searchProducts, type Candidate, type Match, type MatchStatus } from './ace';
import type { StudioFlyer } from './flyer';

/** One Match per hotspot, indexed [page][hotspot]. */
export type Matches = Match[][];

/**
 * Hotspots that already carry SKUs (from the item list) are confirmed by SKU. Item-list items without SKUs
 * arrive with Scheels Search ids built from vendor number + style, which are looked up directly. The rest
 * are found by their printed name. In-store-only hotspots are left as they are.
 */
export async function matchProducts(flyer: StudioFlyer, onProgress: (done: number, total: number) => void): Promise<Matches> {
  const hotspots = flyer.pages.flatMap((page) => page.hotspots);
  const bySku = hotspots.filter((h) => !h.inStoreOnly && h.skus.length);
  const byStyle = hotspots.filter((h) => !h.inStoreOnly && !h.skus.length && h.objectIds?.length);
  const byName = hotspots.filter((h) => !h.inStoreOnly && !h.skus.length && !h.objectIds?.length);
  const total = bySku.length + byStyle.length + byName.length;
  const skuResults = await findBySkus(bySku.map((h) => h.skus));
  const styleProducts = await fetchProducts([...new Set(byStyle.flatMap((h) => h.objectIds ?? []))]);
  const styleById = new Map(styleProducts.map((c) => [c.objectID, c]));
  const styleResults = byStyle.map((h) => (h.objectIds ?? []).map((id) => styleById.get(id)).filter((c): c is Candidate => !!c));
  onProgress(bySku.length + byStyle.length, total);
  const nameResults = await searchProducts(
    byName.map((h) => h.label),
    (done) => onProgress(bySku.length + byStyle.length + done, total),
  );
  const skuMatch = new Map([
    ...bySku.map((h, i): [typeof h, Candidate[]] => [h, skuResults[i] ?? []]),
    ...byStyle.map((h, i): [typeof h, Candidate[]] => [h, styleResults[i] ?? []]),
  ]);
  const nameMatch = new Map(byName.map((h, i) => [h, nameResults[i] ?? []]));
  return flyer.pages.map((page) =>
    page.hotspots.map((h): Match => {
      if (h.inStoreOnly) return { status: 'instore', candidates: [], chosen: [] };
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

/** The flyer with each hotspot's products applied: objectIDs for item-list SKUs, SKUs and objectIDs for name matches. */
export function withChosenSkus(flyer: StudioFlyer, matches: Matches): StudioFlyer {
  return {
    ...flyer,
    pages: flyer.pages.map((page, p) => ({
      ...page,
      hotspots: page.hotspots.map((h, i) => {
        const match = matches[p]?.[i];
        if (!match || match.status === 'instore') return h;
        // Unconfirmed style-based ids would open an empty product drawer on the site, so they are dropped.
        const chosen = match.candidates.filter((c) => match.chosen.includes(c.objectID));
        if (match.status === 'offline' && !chosen.length) return { ...h, objectIds: [] };
        // Item-list SKUs are kept (all colours and sizes) and the products' objectIDs added; items found by
        // style had no SKUs, so they take the products' SKUs.
        if (match.status === 'kept') {
          return { ...h, skus: h.skus.length ? h.skus : chosen.map((c) => c.sku), objectIds: chosen.map((c) => c.objectID) };
        }
        return { ...h, skus: chosen.map((c) => c.sku), objectIds: chosen.map((c) => c.objectID) };
      }),
    })),
  };
}

export function countByStatus(matches: Matches): Record<MatchStatus | 'unresolved', number> {
  const counts = { kept: 0, offline: 0, instore: 0, matched: 0, review: 0, none: 0, unresolved: 0 };
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
  options: { reviewOnly: boolean; readOnly: boolean; onChange: () => void },
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
          el('span', { className: 'muted', textContent: `p.${p + 1}` }),
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
              ? `None of its ${hotspot.skus.length} item-list SKUs is on scheels.com yet. It uses its fallback link until they are.`
              : 'Its item-list style was not found on scheels.com. It uses its fallback link; search Scheels below if it is online.',
          }),
        );
      } else if (match.status === 'none' && !showCandidates) {
        row.append(el('p', { className: 'muted', textContent: 'Scheels Search found nothing. This hotspot uses its search link.' }));
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
          row.append(el('p', { className: 'muted', textContent: 'Nothing ticked: this hotspot uses its search link.' }));
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
