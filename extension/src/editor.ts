import { fetchProducts, searchBatch, type Candidate } from './ace';
import type { FlyerPage, Hotspot } from './flyer';
import { copyText } from './copy';
import {
  defaultButtonText,
  fillFromProducts,
  isExternalUrl,
  linkKind,
  linkPath,
  PATH_ATTRIBUTES,
  toFallbackLink,
  type FallbackLink,
  type LinkKind,
} from './link';

/**
 * Edits the flyer already saved on the item: page images with their hotspots drawn on top. Boxes can
 * be moved, resized, drawn and deleted; a hotspot's text, fallback link and products can be changed,
 * with products found through Scheels Search. Every change is written to the field; the author saves
 * the item as usual.
 */

interface EditorDeps {
  write: (pages: FlyerPage[]) => Promise<string | null>;
  readOnly: () => boolean;
  /** Tells Amplience the frame's content height changed (an image finishing loading is not a DOM change). */
  resize: () => void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = (tag: string, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): HTMLElement => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const hasProduct = (hotspot: Hotspot) => hotspot.skus.length > 0;
const round1 = (v: number) => Math.round(v * 10) / 10;

const state = {
  pages: [] as FlyerPage[],
  page: 0,
  selected: -1,
  drawing: false,
  products: new Map<string, Candidate>(),
  searchResults: [] as Candidate[],
  searchQuery: '',
  confirmDelete: false,
  // Width / height of the last page image, so a new page keeps its space while its image loads.
  aspect: 0,
};
let deps: EditorDeps;
let writeTimer = 0;

const hotspots = () => state.pages[state.page]?.hotspots ?? [];
const selectedHotspot = (): Hotspot | undefined => hotspots()[state.selected];

function setStatus(text: string, kind: 'info' | 'error' | 'ok' = 'info') {
  const status = $('edStatus');
  status.textContent = text;
  status.dataset.kind = kind;
}

/**
 * Writes the pages to the field after a short pause, so a run of quick changes is one write; `now`
 * skips the pause, for when the author may be about to click Save.
 */
function changed(hotspot?: Hotspot, now = false) {
  if (hotspot) hotspot.locked = true;
  setStatus('Unsaved changes. Click Save at the top of Amplience to keep them.');
  window.clearTimeout(writeTimer);
  writeTimer = window.setTimeout(async () => {
    // Half-typed filter rows and emptied fields are left out of what is saved.
    const pages = structuredClone(state.pages).map((page) => ({
      ...page,
      hotspots: page.hotspots.map((h) => ({ ...h, fallback: toFallbackLink(h.fallback) })),
    }));
    const error = await deps.write(pages);
    if (error) setStatus(error, 'error');
  }, now ? 0 : 400);
}

// Ids already asked for, found or not: an id Scheels Search does not know must not be fetched again on
// every render, or the fetch and re-render would loop.
const requestedProducts = new Set<string>();

async function loadProductNames(ids: string[]) {
  const missing = [...new Set(ids)].filter((id) => !state.products.has(id) && !requestedProducts.has(id));
  if (!missing.length) return;
  missing.forEach((id) => requestedProducts.add(id));
  try {
    for (const product of await fetchProducts(missing)) state.products.set(product.objectID, product);
    renderInspector();
  } catch {
    // Names are a convenience; ids still show.
  }
}

// ---------- page and boxes ----------

function imageUrl(page: FlyerPage) {
  const image = page.image;
  return image ? `https://${image.defaultHost}/i/${image.endpoint}/${encodeURIComponent(image.name)}?w=1000` : '';
}

function renderPageControls() {
  const select = $('edPageSelect') as HTMLSelectElement;
  const labels = state.pages.map((page, i) => {
    const missing = page.hotspots.filter((h) => !hasProduct(h)).length;
    return [`Page ${i + 1}`, count(page.hotspots.length, 'hotspot'), missing && `${missing} without a product`, !page.image && 'no image']
      .filter(Boolean)
      .join(' · ');
  });
  // Rebuilt every render so the counts follow added and deleted boxes.
  select.replaceChildren(...labels.map((label, i) => el('option', { value: String(i), textContent: label })));
  select.value = String(state.page);

  const all = state.pages.flatMap((page) => page.hotspots);
  const missing = all.filter((h) => !hasProduct(h)).length;
  $('edSummary').textContent = [
    count(state.pages.length, 'page'),
    count(all.length, 'hotspot'),
    missing && `${missing} without a product`,
  ]
    .filter(Boolean)
    .join(' · ');
  ($('edPrev') as HTMLButtonElement).disabled = state.page === 0;
  ($('edNext') as HTMLButtonElement).disabled = state.page >= state.pages.length - 1;
  const draw = $('edDraw') as HTMLButtonElement;
  draw.disabled = deps.readOnly();
  draw.setAttribute('aria-pressed', String(state.drawing));
}

function renderSheet() {
  const sheet = $('edSheet');
  sheet.replaceChildren();
  sheet.classList.toggle('drawing', state.drawing);
  const page = state.pages[state.page];
  if (!page) return;
  if (!page.image) {
    sheet.style.aspectRatio = '';
    sheet.append(el('p', { className: 'muted empty', textContent: 'This page’s image is not published yet. Publish it and import again to show it.' }));
    return;
  }
  if (state.aspect) sheet.style.aspectRatio = String(state.aspect);
  const img = el('img', { src: imageUrl(page), alt: `Flyer page ${state.page + 1}`, draggable: false }) as HTMLImageElement;
  img.addEventListener('load', () => {
    state.aspect = img.naturalWidth / img.naturalHeight;
    sheet.style.aspectRatio = String(state.aspect);
    deps.resize();
  });
  sheet.append(img);
  page.hotspots.forEach((h, i) => {
    const linked = hasProduct(h);
    const box = el('button', {
      type: 'button',
      className: `hs ${linked ? 'linked' : 'unlinked'}`,
      title: h.label,
    });
    box.setAttribute('aria-pressed', String(i === state.selected));
    box.setAttribute('aria-label', `Hotspot ${i + 1}: ${h.label || 'unnamed'}${linked ? '' : ', no product'}`);
    box.dataset.idx = String(i);
    Object.assign(box.style, { left: `${h.box.x}%`, top: `${h.box.y}%`, width: `${h.box.w}%`, height: `${h.box.h}%` });
    box.append(el('span', { className: 'n', textContent: String(i + 1) }), el('span', { className: 'grip', ariaHidden: 'true' }));
    sheet.append(box);
  });
}

// ---------- inspector ----------

function field(label: string, input: HTMLElement) {
  return el('label', { className: 'f' }, el('span', { textContent: label }), input);
}

function productRow(hotspot: Hotspot, index: number) {
  const objectId = hotspot.objectIds?.[index];
  const product = objectId ? state.products.get(objectId) : undefined;
  const name = product?.title ?? (objectId ? `Product ${objectId}` : 'Product');
  const remove = el('button', { type: 'button', className: 'link', textContent: 'Remove', disabled: deps.readOnly() });
  remove.setAttribute('aria-label', `Remove ${product?.title ?? hotspot.skus[index]}`);
  remove.addEventListener('click', () => {
    hotspot.skus.splice(index, 1);
    hotspot.objectIds?.splice(index, 1);
    changed(hotspot);
    render();
  });
  return el('li', {}, el('span', { textContent: name }), el('span', { className: 'sku', textContent: `SKU ${hotspot.skus[index]}` }), remove);
}

function renderSearch(hotspot: Hotspot) {
  const wrap = el('div', { className: 'search' });
  const input = el('input', { type: 'search', value: state.searchQuery || hotspot.label, id: 'edSearch' }) as HTMLInputElement;
  const go = el('button', { type: 'button', textContent: 'Find product', disabled: deps.readOnly() });
  const run = async () => {
    state.searchQuery = input.value.trim();
    if (!state.searchQuery) return;
    go.textContent = 'Searching…';
    try {
      [state.searchResults] = await searchBatch([state.searchQuery]);
    } catch {
      state.searchResults = [];
      setStatus('Scheels Search could not be reached.', 'error');
    }
    renderInspector();
    $('edSearch')?.focus();
  };
  go.addEventListener('click', run);
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      run();
    }
  });
  wrap.append(el('div', { className: 'row' }, field('Search Scheels', input), go));

  if (state.searchResults.length) {
    const list = el('ul', { className: 'results' });
    for (const candidate of state.searchResults) {
      const added = hotspot.objectIds?.includes(candidate.objectID);
      const add = el('button', { type: 'button', className: 'link', textContent: added ? 'Added' : 'Add', disabled: added || deps.readOnly() });
      add.addEventListener('click', () => {
        hotspot.skus = [...hotspot.skus, candidate.sku];
        hotspot.objectIds = [...(hotspot.objectIds ?? []), candidate.objectID];
        state.products.set(candidate.objectID, candidate);
        changed(hotspot);
        render();
      });
      const price = candidate.salePrices[0] !== undefined ? `$${candidate.salePrices[0]}` : '';
      const details = [price, `SKU ${candidate.sku}`, candidate.inStock ? '' : 'out of stock'].filter(Boolean).join(' · ');
      list.append(el('li', {}, el('span', { textContent: candidate.title }), el('span', { className: 'muted', textContent: details }), add));
    }
    wrap.append(list);
  }
  return wrap;
}

/**
 * A text input whose edits apply to the editor's state on every keystroke but are written to the
 * Amplience field only when the input is left or Enter is pressed: each write makes Amplience
 * re-process the whole flyer, which holds up its form while it does.
 */
function typingInput(
  value: string,
  placeholder: string,
  readOnly: boolean,
  hotspot: Hotspot,
  onInput: (value: string) => void,
  id?: string,
) {
  const node = el('input', { type: 'text', value, placeholder, disabled: readOnly, ...(id ? { id } : {}) }) as HTMLInputElement;
  node.addEventListener('input', () => {
    onInput(node.value);
    hotspot.locked = true;
    setStatus('Editing…');
  });
  node.addEventListener('change', () => changed(hotspot, true));
  return node;
}

const SITE = 'https://www.scheels.com';

/**
 * The link a hotspot opens when it has no product, in the fields of the Amplience link partial: a
 * category, attribute filters (brand, gender, …), on sale, and a search term as the last resort. A
 * preview shows the page it opens on scheels.com.
 */
// The kind of link chosen for a hotspot, kept while its fields are still empty: an empty page link
// would otherwise read as a products link.
const chosenKinds = new WeakMap<Hotspot, LinkKind>();

function renderFallback(hotspot: Hotspot) {
  const ro = deps.readOnly();
  const link: FallbackLink = hotspot.fallback;
  const kind = chosenKinds.get(hotspot) ?? linkKind(link);
  const group = el('div', { className: 'group' });
  // Amplience's sandbox can stop a click from opening a tab; the browser's own "Open Link in New Tab" still works.
  const preview = el('a', {
    target: '_blank',
    rel: 'noopener noreferrer',
    title: 'If clicking does not open it, right-click and choose Open Link in New Tab',
  }) as HTMLAnchorElement;
  let buttonText: HTMLInputElement | undefined;
  const updatePreview = () => {
    if (buttonText) buttonText.placeholder = defaultButtonText(toFallbackLink(link), hotspot.label);
    const path = linkPath(toFallbackLink(link), hotspot.label);
    preview.replaceChildren(path, el('span', { ariaHidden: 'true', textContent: ' ↗' }), el('span', { className: 'sr', textContent: ' (opens in a new tab)' }));
    preview.href = isExternalUrl(path) ? path : SITE + path;
  };
  const edited = () => {
    updatePreview();
    changed(hotspot);
  };
  // The preview follows each keystroke; the field is written once the input is left (see typingInput).
  const input = (value: string, placeholder: string, onInput: (v: string) => void, id?: string) =>
    typingInput(value, placeholder, ro, hotspot, (v) => {
      onInput(v.trim());
      updatePreview();
    }, id);
  // A text field bound to one link property; an emptied field removes the property.
  const linkField = (label: string, key: 'category' | 'searchTerm' | 'urlSlug' | 'pageID' | 'anchor', placeholder: string) =>
    field(
      label,
      input(link[key] ?? '', placeholder, (v) => {
        if (v) link[key] = v;
        else delete link[key];
      }),
    );
  const checkbox = (label: string, key: 'onSale' | 'newPage', checked: boolean) => {
    const box = el('input', { type: 'checkbox', checked, disabled: ro }) as HTMLInputElement;
    box.addEventListener('change', () => {
      if (box.checked) link[key] = true;
      else delete link[key];
      edited();
    });
    return el('label', { className: 'check' }, box, el('span', { textContent: label }));
  };

  // Switching what the link opens clears the other kinds' fields: the site follows the first one set.
  const kindSelect = el(
    'select',
    { disabled: ro },
    ...LINK_KINDS.map(([value, label]) => el('option', { value, textContent: label, selected: value === kind })),
  ) as HTMLSelectElement;
  kindSelect.addEventListener('change', () => {
    const next = kindSelect.value as LinkKind;
    const keep = { newPage: link.newPage, clickID: link.clickID };
    hotspot.fallback = Object.fromEntries(Object.entries(keep).filter(([, v]) => v !== undefined)) as FallbackLink;
    chosenKinds.set(hotspot, next);
    changed(hotspot);
    renderInspector();
  });
  group.append(el('h4', { textContent: 'Link when no product' }), field('Link to', kindSelect));

  if (kind === 'products') renderProductsLink(hotspot, link, group, input, checkbox, linkField);
  else if (kind === 'url') {
    group.append(
      linkField('URL slug', 'urlSlug', 'e.g. /stores or https://www.youtube.com/watch?v=…'),
      el('p', { className: 'muted', textContent: 'A path on scheels.com, like /stores, or a full URL to another site.' }),
      linkField('Anchor (optional, scheels.com pages)', 'anchor', 'e.g. filter-results'),
    );
  } else {
    group.append(linkField('Page ID', 'pageID', 'e.g. deals'), linkField('Anchor (optional)', 'anchor', ''));
  }
  if (kind !== 'products') group.append(checkbox('Open in a new tab', 'newPage', !!link.newPage));

  // Placeholder: the text the site shows when this is left empty.
  buttonText = typingInput(hotspot.buttonText ?? '', defaultButtonText(toFallbackLink(link), hotspot.label), ro, hotspot, (v) => {
    const value = v.trim();
    if (value) hotspot.buttonText = value;
    else delete hotspot.buttonText;
  });
  buttonText.maxLength = 60;
  group.append(field('Button text (optional)', buttonText));

  updatePreview();
  // Amplience's sandbox can block new tabs, so the link can also be copied and pasted into one.
  const copy = el('button', { type: 'button', className: 'link', textContent: 'Copy link' });
  const manual = el('input', { type: 'text', readOnly: true, className: 'copyfield', hidden: true }) as HTMLInputElement;
  manual.setAttribute('aria-label', 'Link to copy');
  copy.addEventListener('click', async () => {
    if (await copyText(preview.href)) {
      copy.textContent = 'Copied';
      return;
    }
    // Copying is blocked too: show the full link selected, ready for Cmd/Ctrl + C.
    manual.value = preview.href;
    manual.hidden = false;
    manual.focus();
    manual.select();
    copy.textContent = 'Press ⌘C / Ctrl+C to copy';
  });
  group.append(
    el('p', { className: 'preview' }, el('span', { className: 'muted', textContent: 'Opens ' }), preview, ' ', copy),
    manual,
  );
  return group;
}

const LINK_KINDS: [LinkKind, string][] = [
  ['products', 'Products (category and filters)'],
  ['content', 'Content page (page ID)'],
  ['url', 'URL slug'],
];

/** The category, filter, on-sale and search-term fields of a link that lists products. */
function renderProductsLink(
  hotspot: Hotspot,
  link: FallbackLink,
  group: HTMLElement,
  input: (value: string, placeholder: string, onInput: (v: string) => void, id?: string) => HTMLInputElement,
  checkbox: (label: string, key: 'onSale' | 'newPage', checked: boolean) => HTMLElement,
  linkField: (label: string, key: 'category' | 'searchTerm', placeholder: string) => HTMLElement,
) {
  const ro = deps.readOnly();
  group.append(linkField('Category key', 'category', 'e.g. boots'));

  const filters = el('div', { className: 'filters' });
  const names = el('datalist', { id: 'edAttrNames' }, ...PATH_ATTRIBUTES.map((n) => el('option', { value: n })));
  (link.attributes ?? []).forEach((attribute, i) => {
    const name = input(attribute.attributeName, 'name', (v) => (attribute.attributeName = v), `edAttr${i}`);
    name.setAttribute('list', 'edAttrNames');
    name.setAttribute('aria-label', `Filter ${i + 1} name`);
    const value = input(attribute.attributeValue, 'value', (v) => (attribute.attributeValue = v));
    value.setAttribute('aria-label', `Filter ${i + 1} value`);
    const remove = el('button', { type: 'button', className: 'link', textContent: 'Remove', disabled: ro });
    remove.setAttribute('aria-label', `Remove filter ${i + 1}`);
    remove.addEventListener('click', () => {
      link.attributes?.splice(i, 1);
      if (!link.attributes?.length) delete link.attributes;
      changed(hotspot);
      renderInspector();
    });
    filters.append(el('div', { className: 'filter' }, name, value, remove));
  });
  const add = el('button', { type: 'button', className: 'link', textContent: '+ Add filter', disabled: ro });
  add.addEventListener('click', () => {
    link.attributes = [...(link.attributes ?? []), { attributeName: link.attributes?.length ? '' : 'brand', attributeValue: '' }];
    renderInspector();
    $(`edAttr${link.attributes.length - 1}`)?.focus();
  });
  group.append(
    el('span', { className: 'flabel', textContent: 'Filters (brand, gender, team, …)' }),
    filters,
    names,
    add,
    checkbox('On sale only', 'onSale', !!link.onSale),
    linkField('Search term (used only with no category or filter)', 'searchTerm', hotspot.label),
  );

  // Category and brand from the products this hotspot links to, for when they go offline.
  const linked = (hotspot.objectIds ?? []).map((id) => state.products.get(id)).filter((c) => !!c);
  if (linked.length) {
    const fill = el('button', { type: 'button', className: 'link', textContent: 'Fill in from linked products', disabled: ro });
    fill.addEventListener('click', () => {
      hotspot.fallback = fillFromProducts(toFallbackLink(link), linked);
      changed(hotspot);
      renderInspector();
    });
    group.append(fill);
  }
}

/** A multi-line note shown under the price on the site, e.g. the terms of an offer. Written when left. */
function descriptionInput(hotspot: Hotspot, readOnly: boolean) {
  const area = el('textarea', {
    value: hotspot.description ?? '',
    rows: 3,
    maxLength: 300,
    placeholder: 'e.g. 20% off all blaze clothing. Excludes Sitka and First Lite.',
    disabled: readOnly,
  }) as HTMLTextAreaElement;
  area.addEventListener('input', () => {
    const value = area.value.trim();
    if (value) hotspot.description = value;
    else delete hotspot.description;
    hotspot.locked = true;
    setStatus('Editing…');
  });
  area.addEventListener('change', () => changed(hotspot, true));
  return area;
}

function inStoreToggle(hotspot: Hotspot) {
  const box = el('input', { type: 'checkbox', checked: !!hotspot.inStoreOnly, disabled: deps.readOnly() }) as HTMLInputElement;
  box.addEventListener('change', () => {
    hotspot.inStoreOnly = box.checked;
    changed(hotspot);
  });
  return el('label', { className: 'check' }, box, el('span', { textContent: 'In store only (no online link)' }));
}

function renderInspector() {
  const panel = $('edInspector');
  panel.replaceChildren();
  const hotspot = selectedHotspot();
  if (!hotspot) {
    const list = hotspots();
    panel.append(
      el('h3', { textContent: `Page ${state.page + 1}` }),
      el('p', {
        className: 'muted',
        textContent: list.length
          ? 'Pick a hotspot to edit it, here or on the page. Drag a box to move it, drag its corner to resize it.'
          : 'No hotspots on this page. Use Draw box to add one.',
      }),
    );
    if (list.length) {
      panel.append(
        el(
          'ul',
          { className: 'hslist' },
          ...list.map((h, i) => {
            const pick = el(
              'button',
              { type: 'button' },
              el('span', { className: 'num', textContent: String(i + 1) }),
              el('span', { className: 'name', textContent: h.label || 'Unnamed' }),
              ...(hasProduct(h) ? [] : [el('span', { className: 'chip review', textContent: 'No product' })]),
            );
            pick.addEventListener('click', () => select(i));
            pick.dataset.idx = String(i);
            return el('li', {}, pick);
          }),
        ),
      );
    }
    return;
  }
  const ro = deps.readOnly();
  const text = (value: string, onInput: (v: string) => void) => typingInput(value, '', ro, hotspot, onInput);
  const back = el('button', { type: 'button', className: 'link back', textContent: '‹ All hotspots on this page' });
  back.addEventListener('click', () => select(-1));
  const details = el('div', { className: 'group' });
  details.append(
    el('h4', { textContent: 'Details' }),
    field('Product name', text(hotspot.label, (v) => (hotspot.label = v))),
    field('Price as printed', text(hotspot.priceText, (v) => (hotspot.priceText = v))),
    field('Description (optional)', descriptionInput(hotspot, ro)),
    inStoreToggle(hotspot),
  );
  const products = el('div', { className: 'group' }, el('h4', { textContent: 'Products' }));
  if (hotspot.skus.length) {
    products.append(el('ul', { className: 'linked' }, ...hotspot.skus.map((_, i) => productRow(hotspot, i))));
    loadProductNames(hotspot.objectIds ?? []);
  } else {
    products.append(el('p', { className: 'warn', textContent: 'No product: this hotspot uses its link below.' }));
  }
  products.append(renderSearch(hotspot));
  panel.append(back, el('h3', { textContent: `Hotspot ${state.selected + 1}` }), details, products, renderFallback(hotspot));

  const del = el('button', {
    type: 'button',
    className: 'danger',
    textContent: state.confirmDelete ? 'Click again to delete' : 'Delete hotspot',
    disabled: ro,
  });
  del.addEventListener('click', () => {
    if (!state.confirmDelete) {
      state.confirmDelete = true;
      renderInspector();
      return;
    }
    hotspots().splice(state.selected, 1);
    select(-1);
    changed();
  });
  panel.append(el('div', { className: 'group' }, del));
}

function render() {
  renderPageControls();
  renderSheet();
  renderInspector();
}

function select(index: number) {
  if (index !== state.selected) {
    state.searchResults = [];
    state.searchQuery = '';
  }
  state.selected = index;
  state.confirmDelete = false;
  render();
}

function goTo(page: number) {
  state.page = clamp(page, 0, state.pages.length - 1);
  state.drawing = false;
  select(-1);
}

// ---------- pointer editing ----------

type Drag =
  | { mode: 'draw'; start: { x: number; y: number }; draft: HTMLElement }
  | { mode: 'move' | 'resize'; idx: number; start: { x: number; y: number }; orig: Hotspot['box']; moved: boolean };
let drag: Drag | null = null;

function pointInSheet(ev: PointerEvent) {
  const rect = $('edSheet').getBoundingClientRect();
  return { x: ((ev.clientX - rect.left) / rect.width) * 100, y: ((ev.clientY - rect.top) / rect.height) * 100 };
}

function wirePointer() {
  const sheet = $('edSheet');
  sheet.addEventListener('pointerdown', (ev) => {
    if (deps.readOnly() || !state.pages[state.page]?.image) return;
    const target = ev.target as HTMLElement;
    const boxEl = target.closest<HTMLElement>('.hs');
    const pt = pointInSheet(ev);
    if (state.drawing && !boxEl) {
      const draft = el('div', { className: 'draft' });
      sheet.append(draft);
      drag = { mode: 'draw', start: pt, draft };
    } else if (boxEl) {
      const idx = Number(boxEl.dataset.idx);
      if (idx !== state.selected) select(idx);
      drag = { mode: target.classList.contains('grip') ? 'resize' : 'move', idx, start: pt, orig: { ...hotspots()[idx].box }, moved: false };
    } else {
      select(-1);
      return;
    }
    sheet.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  sheet.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const pt = pointInSheet(ev);
    const dx = pt.x - drag.start.x;
    const dy = pt.y - drag.start.y;
    if (drag.mode === 'draw') {
      Object.assign(drag.draft.style, {
        left: `${Math.min(pt.x, drag.start.x)}%`,
        top: `${Math.min(pt.y, drag.start.y)}%`,
        width: `${Math.abs(dx)}%`,
        height: `${Math.abs(dy)}%`,
      });
      return;
    }
    if (Math.abs(dx) + Math.abs(dy) > 0.3) drag.moved = true;
    const box = hotspots()[drag.idx].box;
    const o = drag.orig;
    if (drag.mode === 'move') {
      box.x = round1(clamp(o.x + dx, 0, 100 - o.w));
      box.y = round1(clamp(o.y + dy, 0, 100 - o.h));
    } else {
      box.w = round1(clamp(o.w + dx, 1, 100 - o.x));
      box.h = round1(clamp(o.h + dy, 1, 100 - o.y));
    }
    const boxEl = sheet.querySelector<HTMLElement>(`.hs[data-idx="${drag.idx}"]`);
    if (boxEl) Object.assign(boxEl.style, { left: `${box.x}%`, top: `${box.y}%`, width: `${box.w}%`, height: `${box.h}%` });
  });

  // A drag released outside the frame may never deliver pointerup; losing the capture ends it the same way.
  const abandon = () => {
    if (drag?.mode === 'draw') drag.draft.remove();
    else if (drag?.moved) changed(hotspots()[drag.idx]);
    if (drag) render();
    drag = null;
  };
  sheet.addEventListener('pointercancel', abandon);
  sheet.addEventListener('lostpointercapture', () => drag && abandon());

  sheet.addEventListener('pointerup', (ev) => {
    if (!drag) return;
    const current = drag;
    drag = null;
    if (current.mode === 'draw') {
      current.draft.remove();
      const pt = pointInSheet(ev);
      const x = clamp(Math.min(pt.x, current.start.x), 0, 100);
      const y = clamp(Math.min(pt.y, current.start.y), 0, 100);
      const w = Math.abs(pt.x - current.start.x);
      const h = Math.abs(pt.y - current.start.y);
      if (w > 2 && h > 2) {
        const hotspot: Hotspot = {
          label: '',
          priceText: '',
          box: { x: round1(x), y: round1(y), w: round1(clamp(w, 1, 100 - x)), h: round1(clamp(h, 1, 100 - y)) },
          skus: [],
          objectIds: [],
          fallback: {},
          locked: true,
          confidence: 'high',
        };
        hotspots().push(hotspot);
        state.drawing = false;
        changed(hotspot);
        select(hotspots().length - 1);
      }
      return;
    }
    if (current.moved) changed(hotspots()[current.idx]);
    render();
  });

  sheet.addEventListener('keydown', (ev) => {
    const boxEl = (ev.target as HTMLElement).closest<HTMLElement>('.hs');
    if (!boxEl || deps.readOnly()) return;
    const step = ({ ArrowLeft: [-0.5, 0], ArrowRight: [0.5, 0], ArrowUp: [0, -0.5], ArrowDown: [0, 0.5] } as Record<string, number[]>)[ev.key];
    if (!step) return;
    ev.preventDefault();
    const idx = Number(boxEl.dataset.idx);
    const box = hotspots()[idx].box;
    if (ev.shiftKey) {
      box.w = round1(clamp(box.w + step[0], 1, 100 - box.x));
      box.h = round1(clamp(box.h + step[1], 1, 100 - box.y));
    } else {
      box.x = round1(clamp(box.x + step[0], 0, 100 - box.w));
      box.y = round1(clamp(box.y + step[1], 0, 100 - box.h));
    }
    changed(hotspots()[idx]);
    select(idx);
    $('edSheet').querySelector<HTMLElement>(`.hs[data-idx="${idx}"]`)?.focus();
  });

  sheet.addEventListener('click', (ev) => {
    // Keyboard activation (Enter/Space) of a box button selects it; pointer selection happens on pointerdown.
    const boxEl = (ev.target as HTMLElement).closest<HTMLElement>('.hs');
    if (boxEl && (ev as MouseEvent).detail === 0) select(Number(boxEl.dataset.idx));
  });
}

// Hovering or focusing a hotspot in the side list outlines its box on the page, and the other way round.
function hint(idx: string | undefined) {
  document.querySelectorAll('.hs.hint, ul.hslist button.hint').forEach((node) => node.classList.remove('hint'));
  if (idx === undefined) return;
  document.querySelectorAll(`.hs[data-idx="${idx}"], ul.hslist button[data-idx="${idx}"]`).forEach((node) => node.classList.add('hint'));
}

function wireHints() {
  for (const container of [$('edSheet'), $('edInspector')]) {
    const target = (ev: Event) => (ev.target as HTMLElement).closest<HTMLElement>('.hs, ul.hslist button')?.dataset.idx;
    container.addEventListener('pointerover', (ev) => hint(target(ev)));
    container.addEventListener('pointerleave', () => hint(undefined));
    container.addEventListener('focusin', (ev) => hint(target(ev)));
    container.addEventListener('focusout', () => hint(undefined));
  }
}

let wired = false;

/** Shows the editor for `pages` (the field's current value). */
export function openEditor(pages: FlyerPage[], editorDeps: EditorDeps) {
  deps = editorDeps;
  state.pages = structuredClone(pages).map((page) => ({
    ...page,
    hotspots: (page.hotspots ?? []).map((h) => ({
      ...h,
      skus: h.skus ?? [],
      objectIds: h.objectIds ?? [],
      fallback: toFallbackLink(h.fallback, h.label),
    })),
  }));
  state.page = clamp(state.page, 0, Math.max(0, state.pages.length - 1));
  state.selected = -1;
  $('editor').hidden = !state.pages.length;
  if (!wired) {
    wired = true;
    wirePointer();
    wireHints();
    $('edPrev').addEventListener('click', () => goTo(state.page - 1));
    $('edNext').addEventListener('click', () => goTo(state.page + 1));
    ($('edPageSelect') as HTMLSelectElement).addEventListener('change', (e) => goTo(Number((e.target as HTMLSelectElement).value)));
    $('edDraw').addEventListener('click', () => {
      state.drawing = !state.drawing;
      render();
    });
  }
  setStatus('');
  render();
}

export function refreshEditor() {
  if (state.pages.length) render();
}
