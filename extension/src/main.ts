import { init } from 'dc-extensions-sdk';
import type { ContentFieldExtension } from 'dc-extensions-sdk';
import { copyText } from './copy';
import { devSdk } from './dev-sdk';
import {
  buildPages,
  findImage,
  importedBytes,
  PAGES_BUDGET_BYTES,
  parseStudioExport,
  splitPages,
  type FlyerPage,
  type ImageLink,
  type MediaSettings,
  type StudioFlyer,
} from './flyer';
import { openEditor, refreshEditor } from './editor';
import { brandSpellings, linkBrands, type BrandSpellings } from './facets';
import { countByStatus, matchProducts, renderProducts, withChosenSkus, type Matches } from './products';

type Sdk = Pick<ContentFieldExtension<FlyerPage[]>, 'field' | 'form' | 'frame' | 'params' | 'mediaLink'>;
type ImageStatus = 'checking' | 'published' | 'missing';

// Scheels' Amplience media account. Installation parameters `endpoint` / `defaultHost` override it.
const DEFAULT_MEDIA: MediaSettings = { endpoint: 'scheelspoc', defaultHost: 'cdn.media.amplience.net' };
const CHECKS_AT_ONCE = 6;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const state: {
  /** The whole Flyer Studio export. */
  source: StudioFlyer | null;
  /** The export's pages being imported into this item, counted from 1. */
  range: { from: number; to: number };
  /** The export narrowed to those pages: what the steps below check and import. */
  flyer: StudioFlyer | null;
  status: ImageStatus[];
  images: (ImageLink | null)[];
  matches: Matches | null;
  /** Brands in the export's links that Scheels Search spells differently, or doesn't know at all. */
  brands: { spellings: BrandSpellings; unknown: string[] } | null;
  matching: boolean;
  reviewOnly: boolean;
  readOnly: boolean;
  run: number;
} = {
  source: null,
  range: { from: 1, to: 1 },
  flyer: null,
  status: [],
  images: [],
  matches: null,
  brands: null,
  matching: false,
  reviewOnly: true,
  readOnly: false,
  run: 0,
};
let sdk: Sdk;
let media = DEFAULT_MEDIA;
// The Link & Value Generator's address, from the installation parameters (this code is public).
let linkGeneratorUrl = '';
// Amplience's image picker, which only exists inside Amplience.
let pickImage: (() => Promise<ImageLink | null>) | undefined;

function setMessage(text: string, kind: 'info' | 'error' | 'ok' = 'info') {
  const el = $('message');
  el.textContent = text;
  el.dataset.kind = kind;
}

/** Opens the saved flyer in the editor; the import steps fold away once the item has pages. */
async function showCurrent() {
  const pages = (await sdk.field.getValue()) ?? [];
  const hotspots = pages.reduce((n, page) => n + (page.hotspots?.length ?? 0), 0);
  $('current').textContent = pages.length
    ? `This item has ${pages.length} page${pages.length === 1 ? '' : 's'} and ${hotspots} hotspot${hotspots === 1 ? '' : 's'}. Importing replaces them.`
    : 'This item has no pages yet.';
  ($('importer') as HTMLDetailsElement).open = !pages.length;
  $('importerSummary').textContent = pages.length ? 'Replace with a new Flyer Studio export' : 'Import from Flyer Studio';
  openEditor(pages, {
    write: writePages,
    readOnly: () => state.readOnly,
    resize: () => sdk.frame.setHeight(),
    linkGeneratorUrl: linkGeneratorUrl || undefined,
    media,
    pickImage,
    details: readDetails,
  });
}

async function readDetails() {
  const form = ((await sdk.form.getValue().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof form[key] === 'string' ? (form[key] as string) : '');
  return { title: text('title'), campaign: text('campaign'), startDate: text('startDate'), endDate: text('endDate') };
}

async function writePages(pages: FlyerPage[]): Promise<string | null> {
  try {
    const errors = await sdk.field.setValue(pages);
    return Array.isArray(errors) && errors.length ? `Amplience rejected the change: ${errors.map((e) => e.message).join('; ')}` : null;
  } catch (error) {
    return `The change could not be written: ${(error as Error).message}`;
  }
}

async function showDetails(flyer: StudioFlyer) {
  const form = ((await sdk.form.getValue().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const rows: [string, string, string][] = [
    ['Title', 'title', flyer.title],
    ['Campaign code', 'campaign', flyer.campaign],
    ['Sale starts', 'startDate', flyer.startDate],
    ['Sale ends', 'endDate', flyer.endDate],
  ];
  const list = $('details');
  list.replaceChildren();
  for (const [label, key, value] of rows) {
    if (!value) continue;
    const matches = String(form[key] ?? '') === value;
    const row = document.createElement('li');
    const name = Object.assign(document.createElement('span'), { className: 'label', textContent: label });
    const val = Object.assign(document.createElement('code'), { textContent: value });
    const note = Object.assign(document.createElement('span'), {
      className: matches ? 'ok' : 'warn',
      textContent: matches ? 'matches this item' : 'copy into the field above',
    });
    row.append(name, val, note);
    if (!matches) {
      const copy = Object.assign(document.createElement('button'), { type: 'button', className: 'link', textContent: 'Copy' });
      copy.addEventListener('click', async () => {
        copy.textContent = (await copyText(value)) ? 'Copied' : 'Select and copy it';
      });
      row.append(copy);
    }
    list.append(row);
  }
}

const STATUS_TEXT: Record<ImageStatus, string> = {
  checking: 'Checking…',
  published: 'Published',
  missing: 'Not published yet',
};

function renderPages() {
  const flyer = state.flyer;
  const table = $('pages');
  table.replaceChildren();
  $('stepProducts').hidden = !flyer;
  $('step2').hidden = !flyer;
  $('step3').hidden = !flyer;
  if (!flyer) return;

  flyer.pages.forEach((page, i) => {
    const status = state.status[i] ?? 'checking';
    const row = document.createElement('tr');
    [String(state.range.from + i), page.imageName, String(page.hotspots.length), STATUS_TEXT[status]].forEach((text, c) => {
      const td = Object.assign(document.createElement('td'), { textContent: text });
      if (c === 3) td.className = status === 'published' ? 'ok' : status === 'missing' ? 'warn' : 'muted';
      row.append(td);
    });
    table.append(row);
  });

  const checking = state.status.filter((s) => s === 'checking').length;
  const missing = state.status.filter((s) => s === 'missing').length;
  $('imageSummary').textContent = checking
    ? `Checking ${flyer.pages.length} page images…`
    : missing
      ? `${missing} of ${flyer.pages.length} images are not published yet. You can import now; those pages stay hidden on the site until you publish their images and import again.`
      : `All ${flyer.pages.length} page images are published.`;
  ($('applyBtn') as HTMLButtonElement).disabled = state.readOnly || checking > 0 || state.matching;
  ($('recheckBtn') as HTMLButtonElement).disabled = checking > 0;
}

async function checkImages() {
  const flyer = state.flyer;
  if (!flyer) return;
  const run = ++state.run;
  state.status = flyer.pages.map(() => 'checking');
  state.images = flyer.pages.map(() => null);
  renderPages();
  let next = 0;
  const worker = async () => {
    while (next < flyer.pages.length) {
      const i = next++;
      const image = await findImage(flyer.pages[i].imageName, media);
      if (run !== state.run) return;
      state.images[i] = image;
      state.status[i] = image ? 'published' : 'missing';
      renderPages();
    }
  };
  await Promise.all(Array.from({ length: CHECKS_AT_ONCE }, worker));
}

function renderMatches() {
  const flyer = state.flyer;
  if (!flyer) return;
  const summary = $('productSummary');
  const toggle = $('reviewToggle') as HTMLButtonElement;
  renderBrands();
  if (!state.matches) {
    $('productList').replaceChildren();
    toggle.hidden = true;
    return;
  }
  const counts = countByStatus(state.matches);
  const corrected = state.matches.flat().reduce((n, match) => n + (match.corrected?.length ?? 0), 0);
  summary.textContent = [
    counts.kept ? `${counts.kept} confirmed from the item list` : '',
    counts.offline ? `${counts.offline} not online yet` : '',
    corrected ? `${corrected} bean${corrected === 1 ? '' : 's'} corrected to scheels.com's` : '',
    counts.instore ? `${counts.instore} in store only` : '',
    counts.range ? `${counts.range} for a whole range, linked to their listing` : '',
    `${counts.matched} matched by name`,
    `${counts.review} to check${counts.unresolved ? ` (${counts.unresolved} with nothing ticked)` : ''}`,
    `${counts.none} not found`,
  ]
    .filter(Boolean)
    .join(' · ');
  toggle.hidden = false;
  toggle.textContent = state.reviewOnly ? 'Show all products' : 'Show only ones to check';
  renderProducts($('productList'), flyer, state.matches, {
    reviewOnly: state.reviewOnly,
    readOnly: state.readOnly,
    spellings: state.brands?.spellings,
    firstPage: state.range.from,
    onChange: renderMatches,
  });
}

/** What the import changes in the links' brand names, and the brands Scheels Search doesn't know. */
function renderBrands() {
  const note = $('brandSummary');
  const brands = state.brands;
  const lines = [];
  if (brands?.spellings.size) {
    const changes = [...brands.spellings].map(([from, to]) => `${from} → ${to}`).join(', ');
    lines.push(`Brand names in links are changed to Scheels Search's spelling: ${changes}.`);
  }
  if (brands?.unknown.length) {
    const one = brands.unknown.length === 1;
    lines.push(
      `Scheels Search has no brand named ${brands.unknown.join(', ')}, so links filtered on ${one ? 'it' : 'them'} list nothing. ` +
        `Correct ${one ? 'it' : 'them'} in Flyer Studio, or in each hotspot's link after importing.`,
    );
  }
  note.textContent = lines.join(' ');
  note.hidden = !lines.length;
}

async function findProducts() {
  const flyer = state.flyer;
  if (!flyer) return;
  const run = state.run;
  state.matching = true;
  state.matches = null;
  state.brands = null;
  renderMatches();
  renderPages();
  try {
    const links = flyer.pages.flatMap((page) => page.hotspots.filter((h) => !h.inStoreOnly).map((h) => h.fallback));
    const [matches, brands] = await Promise.all([
      matchProducts(flyer, (done, total) => {
        $('productSummary').textContent = `Searching Scheels for ${done} of ${total} products…`;
      }),
      brandSpellings(linkBrands(links)).catch(() => null),
    ]);
    if (run !== state.run || flyer !== state.flyer) return;
    state.matches = matches;
    state.brands = brands;
  } catch (error) {
    $('productSummary').textContent = `Scheels Search could not be reached (${(error as Error).message}). You can still import; hotspots keep any SKUs from Flyer Studio.`;
  } finally {
    state.matching = false;
    renderMatches();
    renderPages();
  }
}

async function chooseFile(file: File) {
  try {
    state.source = parseStudioExport(await file.text());
    const hotspots = state.source.pages.reduce((n, page) => n + page.hotspots.length, 0);
    setMessage(`Read ${file.name}: ${state.source.pages.length} pages, ${hotspots} hotspots.`, 'ok');
    await showDetails(state.source);
    const [first] = splitPages(state.source.pages);
    selectPages(first.from, first.to);
  } catch (error) {
    state.source = null;
    state.flyer = null;
    setMessage((error as Error).message, 'error');
  }
  checkSelection();
}

/** Narrows the import to pages `from` to `to` of the export, kept within its pages. */
function selectPages(from: number, to: number) {
  const source = state.source;
  if (!source) return;
  const last = source.pages.length;
  const start = Math.min(Math.max(Math.round(from) || 1, 1), last);
  const end = Math.min(Math.max(Math.round(to) || last, start), last);
  state.range = { from: start, to: end };
  state.flyer = { ...source, pages: source.pages.slice(start - 1, end) };
}

/** Checks the images and products of the pages now selected. */
function checkSelection() {
  renderRange();
  renderPages();
  checkImages();
  findProducts();
}

const kb = (bytes: number) => `${Math.round(bytes / 1000)} KB`;

/** The page range, and whether those pages fit in one Amplience item; a flyer too big for one gets its split. */
function renderRange() {
  const source = state.source;
  $('range').hidden = !source;
  if (!source) return;
  const { from, to } = state.range;
  const fromInput = $('rangeFrom') as HTMLInputElement;
  const toInput = $('rangeTo') as HTMLInputElement;
  fromInput.max = toInput.max = String(source.pages.length);
  fromInput.value = String(from);
  toInput.value = String(to);
  $('rangeOf').textContent = `of ${source.pages.length}`;

  const bytes = importedBytes(state.flyer?.pages ?? []);
  const runs = splitPages(source.pages);
  const note = $('sizeNote');
  note.dataset.kind = bytes > PAGES_BUDGET_BYTES ? 'error' : '';
  const size =
    bytes > PAGES_BUDGET_BYTES
      ? `Pages ${from}–${to} come to about ${kb(bytes)}, more than one item holds, so Amplience won't save them.`
      : `Pages ${from}–${to} come to about ${kb(bytes)}; one item holds up to 200 KB.`;
  if (runs.length === 1) {
    note.replaceChildren(size);
    return;
  }
  const choices = runs.map((run) => {
    const chosen = run.from === from && run.to === to;
    const button = Object.assign(document.createElement('button'), {
      type: 'button',
      className: 'link',
      textContent: `Pages ${run.from}–${run.to} (${kb(run.bytes)})`,
      disabled: state.readOnly || chosen,
    });
    button.setAttribute('aria-pressed', String(chosen));
    button.addEventListener('click', () => {
      selectPages(run.from, run.to);
      checkSelection();
    });
    return button;
  });
  note.replaceChildren(
    `This flyer is too big for one Amplience item. Import pages ${runs[0].from}–${runs[0].to} into the flyer, ` +
      `and each other set into its own Digital Flyer item, linked under More pages on the flyer: `,
    ...choices.flatMap((button, i) => (i ? [' · ', button] : [button])),
    `. ${size}`,
  );
}

async function apply() {
  if (!state.flyer) return;
  // Amplience requires a product name on every hotspot and would reject the whole import.
  const unnamed = state.flyer.pages.flatMap((page, i) =>
    page.hotspots.flatMap((h, j) => (h.label.trim() ? [] : [`page ${state.range.from + i}, box ${j + 1}`])),
  );
  if (unnamed.length) {
    const one = unnamed.length === 1;
    const shown = unnamed.slice(0, 3).join('; ');
    const list = unnamed.length > 3 ? `${shown} and ${unnamed.length - 3} more` : shown;
    setMessage(
      `Every hotspot needs a product name, and ${list} ${one ? 'has' : 'have'} none. ` +
        `Name ${one ? 'it' : 'them'} in Flyer Studio, save the flyer data again and choose the new file.`,
      'error',
    );
    return;
  }
  try {
    const flyer = state.matches ? withChosenSkus(state.flyer, state.matches, state.brands?.spellings) : state.flyer;
    const errors = await sdk.field.setValue(buildPages(flyer, state.images));
    if (Array.isArray(errors) && errors.length) {
      setMessage(`Amplience rejected the pages: ${errors.map((e) => e.message).join('; ')}`, 'error');
      return;
    }
    const missing = state.images.filter((image) => !image).length;
    setMessage(
      missing
        ? `Imported ${state.flyer.pages.length} pages; ${missing} without an image yet. Click Save at the top of Amplience to keep them.`
        : `Imported ${state.flyer.pages.length} pages. Click Save at the top of Amplience to keep them.`,
      'ok',
    );
    await showCurrent();
  } catch (error) {
    setMessage(`The pages could not be imported: ${(error as Error).message}`, 'error');
  }
}

function setReadOnly(readOnly: boolean) {
  state.readOnly = readOnly;
  ($('fileInput') as HTMLInputElement).disabled = readOnly;
  ($('rangeFrom') as HTMLInputElement).disabled = readOnly;
  ($('rangeTo') as HTMLInputElement).disabled = readOnly;
  renderRange();
  renderPages();
  renderMatches();
  refreshEditor();
}

async function start() {
  const framed = window.parent !== window;
  sdk = framed ? await init<ContentFieldExtension<FlyerPage[]>>() : (devSdk() as unknown as Sdk);
  const installation = (sdk.params?.installation ?? {}) as Partial<MediaSettings> & { studioUrl?: string; linkGeneratorUrl?: string };
  if (installation.studioUrl) ($('studioLink') as HTMLAnchorElement).href = installation.studioUrl;
  linkGeneratorUrl = installation.linkGeneratorUrl ?? '';
  media = {
    endpoint: installation.endpoint || DEFAULT_MEDIA.endpoint,
    defaultHost: installation.defaultHost || DEFAULT_MEDIA.defaultHost,
  };
  // The picker rejects when the author closes it without choosing.
  if (framed) pickImage = () => sdk.mediaLink.getImage().catch(() => null);
  sdk.frame.startAutoResizer();
  setReadOnly(sdk.form.readOnly);
  sdk.form.onReadOnlyChange(setReadOnly);
  if (!framed) setMessage('Running outside Amplience, for local testing.');

  $('fileInput').addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) chooseFile(file);
  });
  const changeRange = () => {
    selectPages(Number(($('rangeFrom') as HTMLInputElement).value), Number(($('rangeTo') as HTMLInputElement).value));
    checkSelection();
  };
  $('rangeFrom').addEventListener('change', changeRange);
  $('rangeTo').addEventListener('change', changeRange);
  $('recheckBtn').addEventListener('click', checkImages);
  $('reviewToggle').addEventListener('click', () => {
    state.reviewOnly = !state.reviewOnly;
    renderMatches();
  });
  $('applyBtn').addEventListener('click', apply);
  await showCurrent();
}

start().catch(() => setMessage('The importer could not connect to Amplience. Reload the content item.', 'error'));
