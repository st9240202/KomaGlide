import { t } from './i18n.js';
// This module is also bundled into the userscript's isolated reader dialog.
export const readerPreferencesKey = 'komaglide.reader.preferences.v1';

export function readReaderPreferences(fallback = {}) {
  let stored;
  try { stored = JSON.parse(localStorage.getItem(readerPreferencesKey)); } catch { /* Storage may be unavailable. */ }
  const saved = { ...fallback, ...stored };
  return {
    mode: ['single', 'double'].includes(saved.mode) ? saved.mode : 'scroll',
    theme: ['light', 'dark'].includes(saved.theme) ? saved.theme : 'system',
    direction: saved.direction === 'ltr' ? 'ltr' : 'rtl',
    tapToTurn: saved.tapToTurn !== false,
    thumbnailSize: ['small', 'large'].includes(saved.thumbnailSize) ? saved.thumbnailSize : 'medium',
  };
}

export function writeReaderPreferences(preferences) {
  try { localStorage.setItem(readerPreferencesKey, JSON.stringify(preferences)); } catch { /* Keep the choice for this reader. */ }
}

function comicProgressKey(key) { return 'komaglide.reader.page.' + JSON.stringify(key); }

export function readComicPosition(key) {
  try {
    const page = Number(localStorage.getItem(comicProgressKey(key)));
    return Number.isSafeInteger(page) && page > 0 ? page : null;
  } catch { return null; }
}

export function writeComicPosition(key, page) {
  try { localStorage.setItem(comicProgressKey(key), String(page)); } catch { /* Keep reading if storage is unavailable. */ }
}

export function watchReaderTheme(paint, signal) {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  let choice = 'system';
  function apply() {
    paint(choice === 'system' ? (systemDark.matches ? 'dark' : 'light') : choice);
  }
  systemDark.addEventListener('change', apply, { signal });
  return theme => { choice = theme; apply(); };
}

export async function makeReaderThumbnail(blob, size = 'medium') {
  if (!blob) return null;
  const bitmap = await createImageBitmap(blob);
  try {
    const large = size === 'large';
    const scale = Math.min(1, (large ? 512 : 192) / bitmap.width, (large ? 682 : 256) / bitmap.height);
    if (scale === 1 && blob.size <= 64 * 1024) return blob;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', large ? .84 : .78));
  } finally { bitmap.close(); }
}

function readerButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

// Reads already sent to the library may finish after a picker closes or reopens.
let activeThumbnailReads = 0;
const thumbnailPumps = new Set();

// Only the visible rows of one group need decoded thumbnails and Blob URLs.
function openThumbnailPicker(container, { total, current, direction, thumbnailSize, onThumbnailSize, getThumbnail, onPick, onClose }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'kg-thumb-picker';
  dialog.setAttribute('aria-label', t('thumbnails'));
  const header = document.createElement('div');
  header.className = 'kg-thumb-head';
  const heading = document.createElement('strong');
  heading.textContent = t('thumbnails');
  const range = document.createElement('span');
  range.className = 'kg-thumb-range';
  const sizeLabel = document.createElement('label');
  sizeLabel.className = 'kg-thumb-size';
  const sizeMenu = document.createElement('select');
  sizeMenu.setAttribute('aria-label', t('thumbnailSize'));
  for (const value of ['small', 'medium', 'large']) {
    sizeMenu.add(new Option(t(value), value));
  }
  sizeMenu.value = thumbnailSize;
  sizeLabel.append(t('thumbnailSize'), sizeMenu);
  const close = readerButton(t('close'), dispose);
  close.setAttribute('aria-label', t('closeThumbnails'));
  header.append(heading, range, sizeLabel, close);
  const grid = document.createElement('div');
  grid.className = 'kg-thumb-grid';
  grid.dir = direction;
  grid.dataset.size = thumbnailSize;
  const footer = document.createElement('div');
  footer.className = 'kg-thumb-footer';
  const batch = 60;
  let start = current - ((current - 1) % batch);
  const back = readerButton(t('previousBatch'), () => show(start - batch, start - 1));
  const more = readerButton(t('nextBatch'), () => show(start + batch, start + batch));
  footer.append(back, more);
  footer.hidden = total <= batch;
  dialog.append(header, grid, footer);
  container.append(dialog);

  const waiting = new Set();
  const entries = new Map();
  let closed = false;
  let lastFocusedTile;
  grid.addEventListener('focusin', event => { lastFocusedTile = event.target.closest('button[data-page]'); });
  function resize(size) {
    if (grid.dataset.size === size) return;
    const viewport = grid.getBoundingClientRect();
    const inView = tile => {
      const box = tile.getBoundingClientRect();
      return box.bottom > viewport.top && box.top < viewport.bottom;
    };
    // Keep the page being browsed in view even after the grid changes its column count.
    const anchor = lastFocusedTile && grid.contains(lastFocusedTile) && inView(lastFocusedTile)
      ? lastFocusedTile : Array.from(grid.children).find(inView);
    const offset = anchor ? anchor.getBoundingClientRect().top - viewport.top : 0;
    sizeMenu.value = size;
    grid.dataset.size = size;
    if (anchor) {
      const box = anchor.getBoundingClientRect();
      const top = Math.max(0, Math.min(offset, grid.clientHeight - box.height));
      grid.scrollTop += box.top - grid.getBoundingClientRect().top - top;
    }
    if (size === 'large') {
      for (const [tile, entry] of entries) {
        if (entry.visible && entry.url && !entry.large && !entry.loading) waiting.add(tile);
      }
      pump();
    }
  }
  sizeMenu.addEventListener('change', () => onThumbnailSize(sizeMenu.value));
  function release(tile) {
    waiting.delete(tile);
    const entry = entries.get(tile);
    if (!entry) return;
    entry.visible = false;
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.url = null;
    if (!entry.loading) entries.delete(tile);
    tile.firstElementChild.replaceChildren();
  }
  async function load(tile, entry, large) {
    const frame = tile.firstElementChild;
    let url;
    try {
      const blob = await getThumbnail(Number(tile.dataset.page), large ? 'large' : 'medium');
      if (!entry.visible) return;
      if (!blob) {
        if (!entry.url) frame.textContent = t('noPreview');
        return;
      }
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      url = URL.createObjectURL(blob);
      img.src = url;
      await img.decode();
      if (!entry.visible) return;
      frame.replaceChildren(img);
      if (entry.url) URL.revokeObjectURL(entry.url);
      entry.url = url;
      entry.large = large;
      url = null;
    } catch {
      if (entry.visible && !entry.url) frame.textContent = t('noPreview');
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  }
  function pump() {
    while (!closed && activeThumbnailReads < 2 && waiting.size) {
      const tile = waiting.values().next().value;
      waiting.delete(tile);
      const entry = entries.get(tile);
      const large = grid.dataset.size === 'large';
      if (entry.loading || (entry.url && (entry.large || !large))) continue;
      entry.loading = true;
      activeThumbnailReads++;
      load(tile, entry, large).finally(() => {
        entry.loading = false;
        if (!entry.visible) entries.delete(tile);
        else if (!large && entry.url && grid.dataset.size === 'large') waiting.add(tile);
        activeThumbnailReads--;
        for (const next of thumbnailPumps) next();
      });
    }
  }
  thumbnailPumps.add(pump);
  const observer = new IntersectionObserver(changes => {
    for (const { target, isIntersecting } of changes) {
      if (!grid.contains(target)) continue;
      if (!isIntersecting) release(target);
      else {
        const entry = entries.get(target) || {};
        if (entry.visible) continue;
        entry.visible = true;
        entries.set(target, entry);
        if (!entry.loading) waiting.add(target);
      }
    }
    pump();
  }, { root: grid, rootMargin: '60px 0px' });
  function clearGrid() {
    observer.disconnect();
    observer.takeRecords();
    for (const tile of entries.keys()) release(tile);
    grid.replaceChildren();
  }
  function show(first, focusPage) {
    clearGrid();
    start = first;
    const last = Math.min(total, start + batch - 1);
    range.textContent = total <= batch
      ? t(total === 1 ? 'pageCountOne' : 'pageCount', {count: total})
      : t('pageRange', {start, end: last, total});
    back.disabled = start === 1;
    more.disabled = last === total;
    for (let page = start; page <= last; page++) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'kg-thumb-page';
      tile.dataset.page = page;
      tile.setAttribute('aria-label', t('pageNumber', {page}));
      if (page === current) tile.setAttribute('aria-current', 'page');
      const frame = document.createElement('span');
      frame.className = 'kg-thumb-frame';
      const label = document.createElement('span');
      label.textContent = String(page);
      tile.append(frame, label);
      grid.append(tile);
      observer.observe(tile);
    }
    const focus = grid.children[focusPage - start];
    focus.focus({ preventScroll: true });
    focus.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  grid.addEventListener('click', event => {
    const tile = event.target.closest('button[data-page]');
    if (!tile) return;
    dispose();
    onPick(Number(tile.dataset.page));
  });
  grid.addEventListener('keydown', event => {
    const tile = event.target.closest('button[data-page]');
    if (!tile) return;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    const step = { ArrowRight: direction === 'rtl' ? -1 : 1, ArrowLeft: direction === 'rtl' ? 1 : -1,
      ArrowUp: -cols, ArrowDown: cols }[event.key];
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    const target = Math.min(total, Math.max(1, Number(tile.dataset.page) + step));
    if (target < start || target >= start + batch) show(target - ((target - 1) % batch), target);
    else grid.children[target - start].focus();
  });
  function dispose() {
    if (closed) return;
    closed = true;
    thumbnailPumps.delete(pump);
    if (dialog.open) dialog.close();
    clearGrid();
    dialog.remove();
    onClose();
  }
  dialog.addEventListener('close', dispose, { once: true });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    dispose();
  });
  dialog.showModal();
  show(start, current);
  return { close: dispose, resize };
}

function bindPageGestures(target, { enabled, tapEnabled, navigate, toggleControls }, listen) {
  const interactive = 'a, button, input, select, textarea, [contenteditable="true"]';
  let press;

  function isTap(event, down) {
    return down && !down.moved && !event.defaultPrevented && event.button === 0 &&
      event.timeStamp - down.time <= 650 &&
      Math.hypot(event.clientX - down.x, event.clientY - down.y) <= 12 &&
      !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey &&
      !event.target.closest(interactive);
  }
  function horizontalFraction(event) {
    const rect = target.getBoundingClientRect();
    return (event.clientX - rect.left) / rect.width;
  }
  function isCenter(x) { return x >= 1 / 3 && x <= 2 / 3; }

  target.addEventListener('pointerdown', event => {
    press = enabled() && event.isPrimary && event.button === 0 && !event.target.closest(interactive)
      ? { x: event.clientX, y: event.clientY, id: event.pointerId, time: event.timeStamp, pointerType: event.pointerType,
        moved: false } : null;
  }, listen);
  target.addEventListener('pointermove', event => {
    if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) {
      press.moved = true;
    }
  }, listen);
  target.addEventListener('pointerup', event => {
    if (press?.pointerType !== 'touch' || press.id !== event.pointerId) return;
    // Some touch interactions never generate a click. Consume the tap here.
    if (enabled() && isTap(event, press) && isCenter(horizontalFraction(event))) {
      press = null;
      toggleControls();
      return;
    }
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) < 1.5 * Math.abs(dy)) return;
    press = null; // A subsequent click must not also turn the page.
    if (enabled() && !event.defaultPrevented) navigate(dx > 0 ? 'left' : 'right');
  }, listen);
  for (const type of ['pointercancel', 'dragstart', 'contextmenu']) {
    target.addEventListener(type, () => { press = null; }, listen);
  }
  target.addEventListener('click', event => {
    const down = press;
    press = null;
    // WebKit can dispatch a mouse click with a different pointer ID after a touch.
    const touchClick = down?.pointerType === 'touch' && event.pointerType === 'mouse';
    if (!enabled() || !isTap(event, down) || event.detail === 0 ||
        (!touchClick && event.pointerId != null && event.pointerId !== down.id)) return;
    const x = horizontalFraction(event);
    if (isCenter(x)) toggleControls();
    else if (tapEnabled()) {
      if (x >= 0 && x < 1 / 3) navigate('left');
      else if (x > 2 / 3 && x <= 1) navigate('right');
    }
  }, listen);
}

export function mountReaderControls(container, options) {
  const { keyTarget, themeTarget, onMode, onTheme, onTurn } = options;
  const toolbar = document.createElement('div');
  toolbar.className = 'kg-reader-controls';
  const lifetime = new AbortController();
  const listen = { signal: lifetime.signal };
  const setTheme = themeTarget && watchReaderTheme(theme => {
    themeTarget.dataset.readerTheme = theme;
  }, lifetime.signal);
  let state = { mode: 'scroll', theme: 'system', direction: 'rtl', tapToTurn: true, current: 1, total: 0 };
  let first = 1;
  let stride = 1;
  let picker;
  let openDrawer;
  const restoreExtras = [];

  function setDrawer(next, returnFocus = false) {
    const previous = openDrawer;
    if (previous) {
      previous.panel.hidden = true;
      previous.toggle.setAttribute('aria-expanded', 'false');
    }
    openDrawer = next;
    if (next) {
      next.panel.hidden = false;
      next.toggle.setAttribute('aria-expanded', 'true');
    } else if (returnFocus) previous?.toggle.focus({ preventScroll: true });
  }

  function drawer(side, title, shortTitle) {
    const wrapper = document.createElement('div');
    wrapper.className = 'kg-edge kg-edge-' + side;
    const panel = document.createElement('section');
    panel.id = 'kg-' + side + '-panel';
    panel.className = 'kg-edge-panel';
    panel.hidden = true;
    const heading = document.createElement('h2');
    heading.id = panel.id + '-title';
    heading.textContent = title;
    panel.setAttribute('aria-labelledby', heading.id);
    panel.append(heading);
    const toggle = readerButton(shortTitle, () => setDrawer(openDrawer === entry ? null : entry));
    toggle.className = 'kg-edge-toggle';
    toggle.title = title;
    toggle.setAttribute('aria-label', title);
    toggle.setAttribute('aria-controls', panel.id);
    toggle.setAttribute('aria-expanded', 'false');
    const entry = { panel, toggle };
    wrapper.append(toggle, panel);
    toolbar.append(wrapper);
    return entry;
  }

  // The chapter links, title, and exit action belong to the surrounding reader.
  // Put them back when navigating to another chapter or refreshing its cache.
  function attachExtras(panel, nodes) {
    if (!nodes?.length) return;
    const extras = document.createElement('div');
    extras.className = 'kg-edge-extras';
    for (const node of nodes) {
      const marker = document.createComment('reader control');
      node.before(marker);
      extras.append(node);
      restoreExtras.push(() => marker.replaceWith(node));
    }
    panel.append(extras);
  }

  const settings = drawer('left', t('readerSettings'), t('settings'));
  const navigation = drawer('right', t('pageNavigation'), t('navigation'));

  function menu(name, choices, change) {
    const label = document.createElement('label');
    const select = document.createElement('select');
    select.setAttribute('aria-label', name);
    for (const [value, text] of choices) select.add(new Option(text, value));
    select.addEventListener('change', () => change(select.value), listen);
    label.append(name, select);
    settings.panel.append(label);
    return select;
  }

  const mode = menu(t('readingMode'), [['scroll', t('verticalScroll')], ['single', t('singlePage')], ['double', t('doublePage')]], onMode);
  if (options.onBufferMode) {
    const buffer = menu(t('bufferMode'), [['chapter', t('bufferChapter')], ['ahead', t('bufferAhead')]], options.onBufferMode);
    buffer.value = options.bufferMode;
  }
  if (options.parallelPreload) {
    const {value, defaultValue, choices, onChange} = options.parallelPreload;
    const pageCount = count => t(count === 1 ? 'pageCountOne' : 'pageCount', {count});
    const preload = menu(t('parallelPreload'), [
      ['default', t('siteDefaultPreload', {pages:pageCount(defaultValue)})],
      ...choices.map(count => [count, pageCount(count)])
    ], onChange);
    preload.value = String(value);
  }
  const theme = menu(t('appearance'), [['system', t('systemTheme')], ['light', t('lightTheme')], ['dark', t('darkTheme')]], onTheme);
  const direction = menu(t('pageDirection'), [['rtl', t('rtl')], ['ltr', t('ltr')]], options.onDirection);
  const tapLabel = document.createElement('label');
  const tap = document.createElement('input');
  tap.type = 'checkbox';
  tap.addEventListener('change', () => options.onTapToTurn(tap.checked), listen);
  tapLabel.append(tap, t('tapToTurn'));
  const browse = readerButton(t('thumbnails'), () => {
    if (picker || state.total < 1) return;
    const current = Math.max(1, Math.min(options.getCurrentPage(), state.total));
    picker = openThumbnailPicker(toolbar, { ...state, current, getThumbnail: options.getThumbnail,
      onThumbnailSize: options.onThumbnailSize,
      onPick: page => { setDrawer(null, true); options.onPick(page); },
      onClose: () => { picker = null; } });
  });
  browse.setAttribute('aria-haspopup', 'dialog');
  settings.panel.append(tapLabel);
  attachExtras(settings.panel, options.settingsExtras);
  const restart = readerButton(t('readFromStart'), () => {
    setDrawer(null, true);
    options.onPick(1);
  });
  navigation.panel.append(browse, restart);
  const pager = document.createElement('span');
  pager.className = 'kg-page-turns';
  function turn(step) {
    const target = first + step * stride;
    if (state.mode !== 'scroll' && target >= 1 && target <= state.total) onTurn(target);
  }
  function sideStep(side) { return (side === 'left') === (state.direction === 'rtl') ? 1 : -1; }
  options.tapTarget.classList.add('kg-page-gestures');
  bindPageGestures(options.tapTarget, {
    enabled: () => !picker,
    tapEnabled: () => state.tapToTurn,
    toggleControls() {
      if (openDrawer) setDrawer(null, true);
      else toolbar.hidden = !toolbar.hidden;
    },
    navigate(side) {
      if (openDrawer) return;
      const step = sideStep(side);
      if (state.mode !== 'scroll') { turn(step); return; }
      const target = options.getCurrentPage() + step;
      if (target >= 1 && target <= state.total) options.onPick(target);
    },
  }, listen);
  const previous = readerButton(t('previousPage'), () => turn(-1));
  const next = readerButton(t('nextPage'), () => turn(1));
  const count = document.createElement('span');
  count.className = 'kg-page-count';
  count.setAttribute('aria-live', 'polite');
  pager.append(previous, count, next);
  navigation.panel.append(pager);
  attachExtras(navigation.panel, options.navigationExtras);
  if (options.progressIndicator) toolbar.append(options.progressIndicator);
  container.append(toolbar);

  keyTarget.addEventListener('click', event => {
    if (!openDrawer || picker || event.composedPath().includes(toolbar)) return;
    event.preventDefault();
    event.stopPropagation();
    setDrawer(null, true);
  }, { capture: true, signal: lifetime.signal });
  keyTarget.addEventListener('keydown', event => {
    if (event.key === 'Escape' && picker && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      picker.close();
      return;
    }
    if (event.key === 'Escape' && openDrawer && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      setDrawer(null, true);
      return;
    }
    if (picker || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        state.mode === 'scroll' || event.composedPath().some(node =>
          node instanceof Element && (node.matches('select, input, textarea') || node.isContentEditable))) return;
    const step = { ArrowLeft: sideStep('left'), ArrowRight: sideStep('right'), PageDown: 1, PageUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    turn(step);
  }, listen);

  function update(changes) {
    const old = state;
    state = { ...state, ...changes };
    if (state.chapterKey !== old.chapterKey || state.total !== old.total || state.direction !== old.direction) picker?.close();
    else if (state.thumbnailSize !== old.thumbnailSize) picker?.resize(state.thumbnailSize);
    stride = state.mode === 'double' ? 2 : 1;
    const page = Math.max(1, Math.min(state.current, state.total));
    first = page - ((page - 1) % stride);
    const last = Math.min(first + stride - 1, state.total);
    mode.value = state.mode;
    theme.value = state.theme;
    direction.value = state.direction;
    tap.checked = state.tapToTurn;
    const rtl = state.direction === 'rtl';
    tapLabel.title = rtl ? t('tapRtl') : t('tapLtr');
    previous.setAttribute('aria-keyshortcuts', rtl ? 'ArrowRight PageUp' : 'ArrowLeft PageUp');
    next.setAttribute('aria-keyshortcuts', rtl ? 'ArrowLeft PageDown' : 'ArrowRight PageDown');
    setTheme?.(state.theme);
    browse.disabled = state.total < 1;
    restart.disabled = state.total < 1;
    pager.hidden = state.mode === 'scroll';
    pager.dataset.direction = state.direction;
    previous.disabled = first <= 1;
    next.disabled = last >= state.total;
    const range = first < last ? first + '–' + last : first;
    count.textContent = state.total ? range + ' / ' + state.total : '0 / 0';
  }
  update({ mode: options.mode || 'scroll', theme: options.theme || 'system', direction: options.direction || 'rtl',
    tapToTurn: options.tapToTurn !== false, thumbnailSize: options.thumbnailSize || 'medium',
    current: options.current || 1, total: options.total || 0 });
  return { update, destroy() {
    picker?.close();
    lifetime.abort();
    options.tapTarget.classList.remove('kg-page-gestures');
    for (const restore of restoreExtras) restore();
    if (themeTarget) delete themeTarget.dataset.readerTheme;
    toolbar.remove();
  } };
}
