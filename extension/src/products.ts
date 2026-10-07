import { decide, searchProducts, type Candidate, type Match, type MatchStatus } from './ace';
import type { StudioFlyer } from './flyer';

/** One Match per hotspot, indexed [page][hotspot]. */
export type Matches = Match[][];

export async function matchProducts(flyer: StudioFlyer, onProgress: (done: number, total: number) => void): Promise<Matches> {
  const hotspots = flyer.pages.flatMap((page) => page.hotspots);
  const candidates = await searchProducts(
    hotspots.map((h) => h.label),
    (done) => onProgress(done, hotspots.length),
  );
  let k = 0;
  return flyer.pages.map((page) => page.hotspots.map((h) => decide(h.label, h.priceText, h.skus, candidates[k++] ?? [])));
}

/** The flyer with each hotspot's SKUs and objectIDs set from the chosen products; hotspots that kept SKUs are unchanged. */
export function withChosenSkus(flyer: StudioFlyer, matches: Matches): StudioFlyer {
  return {
    ...flyer,
    pages: flyer.pages.map((page, p) => ({
      ...page,
      hotspots: page.hotspots.map((h, i) => {
        const match = matches[p]?.[i];
        if (!match || match.status === 'kept') return h;
        const chosen = match.candidates.filter((c) => match.chosen.includes(c.objectID));
        return { ...h, skus: chosen.map((c) => c.sku), objectIds: chosen.map((c) => c.objectID) };
      }),
    })),
  };
}

export function countByStatus(matches: Matches): Record<MatchStatus | 'unresolved', number> {
  const counts = { kept: 0, matched: 0, review: 0, none: 0, unresolved: 0 };
  for (const match of matches.flat()) {
    counts[match.status]++;
    if (match.status === 'review' && !match.chosen.length) counts.unresolved++;
  }
  return counts;
}

const STATUS_LABEL: Record<MatchStatus, string> = {
  kept: 'SKU from Flyer Studio',
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
      if (options.reviewOnly && match.status !== 'review' && match.status !== 'none') return;

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

      if (match.status === 'kept') {
        row.append(el('p', { className: 'muted', textContent: `Keeps ${hotspot.skus.join(', ')}.` }));
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
