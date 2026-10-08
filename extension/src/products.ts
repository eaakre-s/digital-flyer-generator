import { decide, fetchProducts, findBySkus, searchProducts, type Candidate, type Match, type MatchStatus } from './ace';
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
        if (match.status === 'offline') return { ...h, objectIds: [] };
        const chosen = match.candidates.filter((c) => match.chosen.includes(c.objectID));
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

      if (match.status === 'instore') {
        row.append(el('p', { className: 'muted', textContent: 'Shown as in store only; no online link.' }));
      } else if (match.status === 'offline') {
        row.append(
          el('p', {
            className: 'muted',
            textContent: hotspot.skus.length
              ? `None of its ${hotspot.skus.length} item-list SKUs is on scheels.com yet. It uses its fallback link until they are.`
              : 'Its item-list style was not found on scheels.com. It uses its fallback link; add a product with Show all products if it is online.',
          }),
        );
      } else if (match.status === 'none') {
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
        row.append(list);
        if (!match.chosen.length) {
          row.append(el('p', { className: 'muted', textContent: 'Nothing ticked: this hotspot uses its search link.' }));
        }
      }
      container.append(row);
    }),
  );
  if (!container.children.length) {
    container.append(el('li', { className: 'muted', textContent: 'Nothing left to check.' }));
  }
}
