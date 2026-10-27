/**
 * The product listing URLs scheels.com builds for a category or filter link, so the editor's preview
 * matches the site. The site lays filters out by URL rules that Scheels Search serves (/c/boots/b/danner/sale:
 * `b` is the brand rule, `sale` a toggle) and puts every filter without a rule in ?r=.
 *
 * Ported from customer-scheels: buildFilterPath in frontend/helpers/urlRules.ts, buildFilterUrl and
 * linkAttributeToRefinementKey in frontend/store/search/urlSync.ts, and buildCategoryUrl in
 * AmplienceLink (atoms/amplience/amplience-link.tsx). Keep them in step.
 */

import type { FallbackLink } from './link';

export interface UrlRule {
  /** Search refinement key, e.g. brand or attributes.gender. May hold a {customerGroup} placeholder. */
  attribute: string;
  kind: 'prefix' | 'value' | 'toggle';
  sortOrder: number;
  /** The path word. */
  segment: string;
  /** `value` rules: the values the word stands for (kids = Boys + Girls). */
  refinementValues: string[] | null;
  /** False for an old word that is read but never written. */
  canonical: boolean;
}

const RULES_URL = 'https://search.scheels.com/api/indexes/commercetools_products/url-rules';
// The pricing group of a shopper who isn't signed in to a group, as the site's providers set it.
const CUSTOMER_GROUP = 'default';
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

let rules: UrlRule[] = [];
let loading: Promise<void> | null = null;

/**
 * Fetches the rules once. Until they arrive, or if they can't be fetched, links are built with no
 * rules: every filter in ?r=, which the site still reads.
 */
export function loadUrlRules(): Promise<void> {
  loading ??= fetch(RULES_URL)
    .then((res) => (res.ok ? res.json() : []))
    .then((data: unknown) => {
      // The site drops rules naming a placeholder other than {customerGroup}, which it can't fill.
      rules = (Array.isArray(data) ? (data as UrlRule[]) : []).filter((r) =>
        Array.from(r.attribute.matchAll(PLACEHOLDER)).every((m) => m[1] === 'customerGroup'),
      );
    })
    .catch(() => undefined);
  return loading;
}

export const urlRulesLoaded = () => rules.length > 0;

// ---------- filter path (helpers/urlRules.ts) ----------

const normalizeValues = (values: string[]): string[] => {
  const unique = Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
  return unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
};
const foldValues = (values: string[]) => normalizeValues(values.map((v) => v.toLowerCase()));
const sameValues = (a: string[] | null, b: string[] | null): boolean => {
  const left = foldValues(a ?? []);
  const right = foldValues(b ?? []);
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

const toggleMatcher = (attribute: string) =>
  new RegExp(
    `^${attribute
      .split(PLACEHOLDER)
      .map((part, i) => (i % 2 ? '[^.]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('')}$`,
  );

const pathValues = (values: string[]) =>
  Array.from(new Set(values.map((v) => encodeURIComponent(v.toLowerCase()))))
    .sort()
    .join('_');

interface BuildFilter {
  attribute: string;
  values: string[];
}

function buildFilterPath(filters: BuildFilter[], ruleList: UrlRule[]): { path: string; remaining: BuildFilter[] } {
  const remaining = new Map(filters.filter((f) => f.values.length > 0).map((f) => [f.attribute, f.values]));
  const path: string[] = [];

  const attributes = Array.from(new Map(ruleList.map((r) => [r.attribute, r])).values()).sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  for (const attr of attributes) {
    const canonical = ruleList.filter((r) => r.attribute === attr.attribute && r.canonical);
    if (canonical.length === 0) continue;

    if (attr.kind === 'prefix') {
      const values = remaining.get(attr.attribute);
      if (!values) continue;
      path.push(canonical[0].segment, pathValues(values));
      remaining.delete(attr.attribute);
    } else if (attr.kind === 'value') {
      const values = remaining.get(attr.attribute);
      if (!values) continue;
      const exact = canonical.find((r) => sameValues(r.refinementValues, values));
      if (exact) {
        path.push(exact.segment);
      } else {
        const singles = foldValues(values).map((v) => canonical.find((r) => sameValues(r.refinementValues, [v])));
        if (!singles.every(Boolean)) continue;
        path.push(
          singles
            .map((r) => r!.segment)
            .sort()
            .join('_'),
        );
      }
      remaining.delete(attr.attribute);
    } else {
      const matcher = toggleMatcher(attr.attribute);
      const key = Array.from(remaining.keys()).find((k) => matcher.test(k));
      if (!key) continue;
      path.push(canonical[0].segment);
      remaining.delete(key);
    }
  }

  return {
    path: path.length ? `/${path.join('/')}` : '',
    remaining: Array.from(remaining, ([attribute, values]) => ({ attribute, values })),
  };
}

// ---------- ?r= keys and the whole URL (store/search/urlSync.ts) ----------

const refinementKeyToSlug = (refinementKey: string) =>
  refinementKey.replaceAll('attributes.', '').replaceAll('variants.', '');

const slugToRefinementKey = (slug: string) => {
  if (slug === '') return '';
  if (slug === 'onSale') return `variants.${slug}`;
  const nonAttributeRefinements = [
    'brand',
    'objectID',
    'shop',
    'subclass',
    'class',
    'productType',
    'storeAvailability',
    'promotionalSale',
  ];
  if (nonAttributeRefinements.includes(slug) || slug.match(/pricing\.groups\..+\.onSale/g)) return slug;
  return `attributes.${slug}`;
};

// Link attribute names authors have used since before URL rules, which don't spell their refinement key.
const LEGACY_LINK_ATTRIBUTES: Record<string, string> = {
  promo: 'attributes.promotion',
  vendorcollection: 'attributes.vendorCollection',
};

/** The refinement key a link attribute name filters on, e.g. "vendorcollection" → attributes.vendorCollection. */
const linkAttributeToRefinementKey = (attributeName: string, ruleList: UrlRule[]) => {
  const name = attributeName.toLowerCase();
  if (name in LEGACY_LINK_ATTRIBUTES) return LEGACY_LINK_ATTRIBUTES[name];
  const rule = ruleList.find((r) => r.attribute.replace(/^attributes\./, '').toLowerCase() === name);
  return rule?.attribute ?? slugToRefinementKey(attributeName);
};

function buildFilterUrl(
  {
    route,
    refinementList,
    toggle,
    params = {},
  }: {
    route: string;
    refinementList: Record<string, string[]>;
    toggle: Record<string, boolean>;
    params?: Record<string, string>;
  },
  ruleList: UrlRule[],
) {
  const refinements = { ...refinementList };
  const toggles = { ...toggle };

  const toggleMatchers = ruleList.filter((r) => r.kind === 'toggle').map((r) => toggleMatcher(r.attribute));
  for (const key of Object.keys(refinements)) {
    if (toggleMatchers.some((matcher) => matcher.test(key))) {
      toggles[key] = refinements[key].includes('true');
      delete refinements[key];
    }
  }

  const { path, remaining } = buildFilterPath(
    [
      ...Object.keys(toggles)
        .filter((key) => toggles[key])
        .map((attribute) => ({ attribute, values: ['true'] })),
      ...Object.entries(refinements).map(([attribute, values]) => ({ attribute, values })),
    ],
    ruleList,
  );

  const r = remaining
    .map(
      ({ attribute, values }) =>
        `${refinementKeyToSlug(attribute)}:${values.map((v) => encodeURIComponent(v)).join('|')}`,
    )
    .join(';');

  const queryString = Object.entries({ r, ...params })
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');

  return `${route}${path}${queryString ? `?${queryString}` : ''}`.replaceAll(',', '');
}

// ---------- a link's listing URL (AmplienceLink's buildCategoryUrl) ----------

const LINK_QUERY_PARAMS = ['srule', 'pmin', 'pmax'];

const capitalizeWords = (value: string) =>
  value
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

/** The product listing URL a category or filter link opens, its filters laid out by the URL rules. */
export function categoryUrl(link: FallbackLink): string {
  const refinementList: Record<string, string[]> = {};
  const toggle: Record<string, boolean> = {};
  const params: Record<string, string> = {};
  const add = (key: string, values: string[]) => {
    refinementList[key] = Array.from(new Set([...(refinementList[key] ?? []), ...values]));
  };

  if (link.onSale) toggle[`pricing.groups.${CUSTOMER_GROUP}.onSale`] = true;

  for (const { attributeName, attributeValue } of link.attributes ?? []) {
    const name = attributeName.toLowerCase();
    if (LINK_QUERY_PARAMS.includes(name)) {
      params[name] = attributeValue;
      continue;
    }
    if (name === 'promotionalsale') {
      toggle.promotionalSale = true;
      continue;
    }

    const key = linkAttributeToRefinementKey(attributeName, rules);
    const keyRules = rules.filter((r) => r.attribute === key);
    const knownValues = keyRules.flatMap((r) => r.refinementValues ?? []);
    for (const value of attributeValue
      .split('|')
      .map((v) => v.trim())
      .filter(Boolean)) {
      // A value written as one of its attribute's path words (gender: kids) stands for that word's values.
      const word = keyRules.find((r) => r.kind === 'value' && r.segment === value.toLowerCase());
      if (word) {
        add(word.attribute, word.refinementValues ?? []);
        continue;
      }
      add(key, [knownValues.find((known) => known.toLowerCase() === value.toLowerCase()) ?? capitalizeWords(value)]);
    }
  }

  // Several product IDs list just those products.
  if (link.productID?.includes('|')) add('objectID', link.productID.split('|'));

  return buildFilterUrl({ route: `/c/${link.category || 'all'}`, refinementList, toggle, params }, rules);
}

/**
 * Attribute names a link can filter on, for suggestions: the URL rules' (brand, gender, team, …), then
 * the few the site reads specially.
 */
export function linkAttributeNames(): string[] {
  const fromRules = rules
    .filter((r) => r.kind !== 'toggle' && r.canonical)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => r.attribute.replace(/^attributes\./, ''));
  const base = fromRules.length ? fromRules : ['brand', 'gender', 'team', 'vendorCollection', 'promotion'];
  return [...new Set([...base, 'promotionalsale', 'pmin', 'pmax', 'srule'])];
}
