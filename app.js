import { buildIndex, search, highlightTerms, detectIntent, normalize, TIME_BANDS } from './search.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  sessions: [],
  meta: null,
  index: [],
  day: 1,
  query: '',
  cat: '',
  room: '',
  tags: new Set(),
  favs: new Set(),
  tagCloud: [],
  view: 'list',
  now: new Date(),
};

const STORE_FAV = 'cedec2026.favs';
const STORE_VIEW = 'cedec2026.view';

const els = {
  list: $('#list'),
  tabs: $('#tabs'),
  q: $('#q'),
  clear: $('#btn-clear'),
  filters: $('#filters'),
  status: $('#status'),
  sheet: $('#sheet'),
  sheetBody: $('#sheet-body'),
  footMeta: $('#foot-meta'),
  view: $('#btn-view'),
  viewList: $('#btn-view-list'),
  menu: $('#menu'),
  btnMenu: $('#btn-menu'),
  menuFilters: $('#menu-filters'),
  menuNote: $('#menu-note'),
  fav: $('#btn-fav-bottom'),
  favCount: $('#fav-count-bottom'),
  filtersFloat: $('#btn-filters-float'),
  offline: $('#offline'),
};

// ---------------------------------------------------------------- utilities

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function highlight(text, terms) {
  const safe = esc(text);
  if (!terms.length) return safe;
  const normSafe = normalize(safe);
  // Highlight on the original string by scanning normalized positions is lossy
  // for mixed-width text, so fall back to a plain case-insensitive pass.
  let out = safe;
  for (const term of terms.slice(0, 6)) {
    if (term.length < 2) continue;
    if (!normSafe.includes(term)) continue;
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, (m) => `<span class="mark">${m}</span>`);
  }
  return out;
}

function minutesNow(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function todayIso(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function dayLabel(dateIso) {
  const [, m, d] = dateIso.split('-');
  const wd = ['日', '月', '火', '水', '木', '金', '土'][new Date(`${dateIso}T00:00:00`).getDay()];
  return `${Number(m)}/${Number(d)}(${wd})`;
}

function loadFavs() {
  try {
    const raw = localStorage.getItem(STORE_FAV);
    if (raw) state.favs = new Set(JSON.parse(raw));
  } catch { /* ignore */ }
}

function saveFavs() {
  try {
    localStorage.setItem(STORE_FAV, JSON.stringify([...state.favs]));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- url state

function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.has('d')) state.day = h.get('d') === 'fav' ? 'fav' : Number(h.get('d')) || 1;
  if (h.has('q')) state.query = h.get('q');
  if (h.has('c')) state.cat = h.get('c');
  if (h.has('r')) state.room = h.get('r');
  if (h.has('t')) state.tags = new Set(h.get('t').split(',').filter(Boolean));
  return null;
}

function writeHash() {
  const h = new URLSearchParams();
  h.set('d', String(state.day));
  if (state.query) h.set('q', state.query);
  if (state.cat) h.set('c', state.cat);
  if (state.room) h.set('r', state.room);
  if (state.tags.size) h.set('t', [...state.tags].join(','));
  const next = `#${h.toString()}`;
  // Keep history.state intact: the detail sheet stores its open flag there.
  if (location.hash !== next) history.replaceState(history.state, '', next);
}

// ---------------------------------------------------------------- rendering

function renderTabs() {
  const days = state.meta.days ?? [];
  const searching = state.query.trim().length > 0;
  const parts = days.map((d) => {
    const isToday = d.date === todayIso(state.now);
    const [, m, day] = d.date.split('-');
    const wd = ['日', '月', '火', '水', '木', '金', '土'][new Date(`${d.date}T00:00:00`).getDay()];
    return `<button type="button" class="tab ${isToday ? 'tab--today' : ''}" role="tab"
      data-day="${d.day}" aria-selected="${!searching && state.day === d.day}"
      >${Number(m)}/${Number(day)}<span class="tab__sub">${wd}</span></button>`;
  });
  els.tabs.innerHTML = parts.join('');
  els.favCount.textContent = String(state.favs.size);
  els.fav.setAttribute('aria-pressed', String(state.day === 'fav'));
}

/** Keyword tags with their frequency, biggest first. */
function buildTagCloud() {
  const counts = new Map();
  for (const s of state.sessions) {
    for (const raw of s.keywords ?? []) {
      const tag = raw.trim();
      if (!tag) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const max = entries[0]?.[1] ?? 1;
  const min = entries[entries.length - 1]?.[1] ?? 1;
  state.tagCloud = entries.map(([tag, count]) => ({
    tag,
    count,
    // 0..1 -> font scale, so heavy tags read as heavier.
    heat: max === min ? 0.5 : (count - min) / (max - min),
  }));
}

function renderFilters() {
  const cats = state.meta.categories ?? [];
  const catOptions = cats
    .map(
      (c) => `<option value="${esc(c.code)}" ${state.cat === c.code ? 'selected' : ''}>${esc(
        c.label || c.code,
      )}</option>`,
    )
    .join('');
  const roomOptions = (state.meta.rooms ?? [])
    .map((r) => `<option value="${esc(r)}" ${state.room === r ? 'selected' : ''}>第${esc(r)}会場</option>`)
    .join('');
  const cloud = state.tagCloud
    .map(
      (t) => `<button type="button" class="tagcloud__item" data-tag="${esc(t.tag)}"
        aria-pressed="${state.tags.has(t.tag)}"
        style="font-size:${(12 + t.heat * 6).toFixed(1)}px"
        >${esc(t.tag)}<span class="tagcloud__n">${t.count}</span></button>`,
    )
    .join('');
  // Order matters: the sheet slides up from the bottom, so the controls that
  // should be easiest to reach go last.
  els.filters.innerHTML = `
    <div class="filters__group">
      <div class="filters__label">キーワード</div>
      <div class="tagcloud">${cloud}</div>
    </div>
    <div class="filters__row">
      <label class="select">
        <span class="select__label">カテゴリ</span>
        <select id="sel-cat"><option value="">すべて</option>${catOptions}</select>
      </label>
      <label class="select">
        <span class="select__label">会場</span>
        <select id="sel-room"><option value="">すべて</option>${roomOptions}</select>
      </label>
    </div>
    <div class="filters__group filters__foot">
      <button type="button" class="chip" data-reset>絞り込みを解除</button>
    </div>`;
}

function sessionCard(s, terms, liveState, showDate) {
  const cat = s.category ? `<span class="cat cat-${esc(s.category)}">${esc(s.category)}</span>` : '';
  const room = s.room ? `第${esc(s.room)}会場` : '';
  const time = s.start ? `<strong>${esc(s.start)}</strong>–${esc(s.end ?? '')}` : '日時未定';
  const badge =
    liveState === 'live'
      ? '<span class="tag tag--live">開催中</span>'
      : liveState === 'next'
        ? '<span class="tag tag--next">まもなく</span>'
        : '';
  const speakers = (s.speakers ?? [])
    .map(
      (x) =>
        `<span class="sp"><span class="sp__name">${highlight(x.name, terms)}</span>${
          x.company ? `<span class="sp__co">${highlight(x.company, terms)}</span>` : ''
        }</span>`,
    )
    .join('');
  // One-line gist: the first bullet of "what you get" reads better than the
  // opening of the abstract, so prefer it.
  const gist = (s.takeaway || s.description || '')
    .split('\n')[0]
    .replace(/^[・･\-‐-―\s]+/, '')
    .slice(0, 88);
  const fav = state.favs.has(s.id);
  return `<div class="card cat-edge-${esc(s.category || 'none')} ${liveState === 'live' ? 'card--live' : ''} ${
    liveState === 'past' ? 'card--past' : ''
  } ${fav ? 'card--fav' : ''}" data-id="${esc(s.id)}" role="button" tabindex="0">
    <div class="card__head">${showDate && s.date ? `<span class="card__date">${dayLabel(s.date)}</span>` : ''}${time}${
      room ? ' · ' + room : ''
    }${cat ? ' · ' + cat : ''} ${badge}</div>
    <h2 class="card__title">${highlight(s.title, terms)}</h2>
    ${speakers ? `<p class="card__speakers">${speakers}</p>` : ''}
    ${gist ? `<p class="card__snippet">${highlight(gist, terms)}…</p>` : ''}
    <button type="button" class="card__star" data-star="${esc(s.id)}"
      aria-pressed="${fav}" aria-label="マイプランに追加">${fav ? '★' : '☆'}</button>
  </div>`;
}

function liveStateOf(s) {
  const today = todayIso(state.now);
  if (!s.date || s.startMin == null) return '';
  if (s.date < today) return 'past';
  if (s.date !== today) return '';
  const nowMin = minutesNow(state.now);
  if (nowMin >= s.startMin && nowMin < s.endMin) return 'live';
  if (s.startMin - nowMin > 0 && s.startMin - nowMin <= 30) return 'next';
  if (s.endMin <= nowMin) return 'past';
  return '';
}

function applyFilters(list, intent) {
  return list.filter((s) => {
    if (state.cat && s.category !== state.cat) return false;
    if (state.room && s.room !== state.room) return false;
    if (state.tags.size && !(s.keywords ?? []).some((k) => state.tags.has(k.trim()))) return false;
    if (intent?.categories?.length && !intent.categories.includes(s.category)) return false;
    if (intent?.level != null && s.difficulty?.level !== intent.level) return false;
    if (intent?.day != null && s.day !== intent.day) return false;
    if (intent?.band && (s.startMin == null || s.startMin < intent.band.from || s.startMin >= intent.band.to))
      return false;
    return true;
  });
}

function render() {
  const query = state.query.trim();
  const searching = query.length > 0;
  const terms = searching ? highlightTerms(query) : [];
  let notes = [];

  let rows;
  if (searching) {
    const intent = detectIntent(query, state.meta.categories);
    const hits = intent.rest ? search(intent.rest, state.index) : null;
    let picked;
    if (hits) {
      picked = hits.map((h) => ({ s: state.sessions[h.index], score: h.score }));
    } else {
      picked = state.sessions.map((s) => ({ s, score: 0 }));
    }
    const filtered = applyFilters(picked.map((p) => p.s), intent);
    const keep = new Set(filtered.map((s) => s.id));
    rows = picked.filter((p) => keep.has(p.s.id)).map((p) => p.s);

    if (intent.day) notes.push(`${intent.day}日目`);
    if (intent.band) notes.push(intent.band.label);
    if (intent.level != null) notes.push(intent.level === 1 ? '入門寄り' : '上級寄り');
    if (intent.categories.length) notes.push(intent.categories.join('/'));
    els.status.textContent = `全日程から ${rows.length}件${
      notes.length ? ' · ' + notes.join(' · ') : ''
    }`;
    els.list.innerHTML = rows.length
      ? renderRows(rows, terms, false)
      : `<div class="empty">見つからなかった<div class="empty__hint">
          言葉を減らすか、別の言い方を試してみて<br>例:「AI 効率化」「新人 育成」「描画 最適化」</div></div>`;
  } else {
    const base =
      state.day === 'fav'
        ? state.sessions.filter((s) => state.favs.has(s.id))
        : state.sessions.filter((s) => s.day === state.day);
    rows = applyFilters(base, null);
    const narrowed = [];
    if (state.cat) narrowed.push(state.cat);
    if (state.room) narrowed.push(`第${state.room}会場`);
    if (state.tags.size) narrowed.push([...state.tags].join('/'));
    els.status.textContent = `${rows.length}件${narrowed.length ? ' · ' + narrowed.join(' · ') : ''}`;
    if (state.view === 'grid' && state.day !== 'fav') {
      els.list.innerHTML = rows.length ? renderGrid(rows) : emptyMessage();
    } else {
      els.list.innerHTML = rows.length ? renderRows(rows, terms, true) : emptyMessage();
    }
  }
  els.list.classList.toggle('list--grid', state.view === 'grid' && !searching && state.day !== 'fav');

  renderTabs();
  writeHash();
  scrollToNow(searching);
  const nowBtn = $('#btn-now');
  const canJump = viewingToday() && !searching && state.day !== 'fav';
  nowBtn.hidden = !canJump;
  nowBtn.textContent = state.view === 'grid' ? '今の時間へ' : '今やってる講演へ';
}

function emptyMessage() {
  if (state.day === 'fav')
    return `<div class="empty">マイプランは空っぽ<div class="empty__hint">
      カードの右下の ☆ を押すと、ここに集まるよ</div></div>`;
  return `<div class="empty">条件に合うセッションが無い<div class="empty__hint">
    絞り込みを解除してみて</div></div>`;
}

// Wall-clock grid: rooms across, time down. Useful on a tablet or when the
// phone is turned sideways.
const PX_PER_MIN = 2.4;

function renderGrid(rows) {
  const dated = rows.filter((s) => s.startMin != null && s.room);
  if (!dated.length) return emptyMessage();

  const rooms = [...new Set(dated.map((s) => s.room))].sort((a, b) => Number(a) - Number(b));
  const from = Math.floor(Math.min(...dated.map((s) => s.startMin)) / 30) * 30;
  const to = Math.ceil(Math.max(...dated.map((s) => s.endMin ?? s.startMin + 60)) / 30) * 30;
  const height = (to - from) * PX_PER_MIN;

  const ticks = [];
  for (let m = from; m <= to; m += 30) {
    ticks.push(`<div class="grid__tick" style="top:${(m - from) * PX_PER_MIN}px">${String(
      Math.floor(m / 60),
    ).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}</div>`);
  }

  const today = todayIso(state.now);
  const nowMin = minutesNow(state.now);
  const showNow =
    (state.meta.days ?? []).some((d) => d.date === today && d.day === state.day) &&
    nowMin >= from &&
    nowMin <= to;

  const columns = rooms
    .map((room) => {
      const cells = dated
        .filter((s) => s.room === room)
        .map((s) => {
          const top = (s.startMin - from) * PX_PER_MIN;
          const h = Math.max(((s.endMin ?? s.startMin + 60) - s.startMin) * PX_PER_MIN - 3, 22);
          const fav = state.favs.has(s.id);
          const ls = liveStateOf(s);
          return `<div class="gcell cat-edge-${esc(s.category || 'none')} ${
            ls === 'live' ? 'gcell--live' : ''
          } ${ls === 'past' ? 'gcell--past' : ''}"
            style="top:${top}px;height:${h}px" data-id="${esc(s.id)}" role="button" tabindex="0">
            <div class="gcell__title">${fav ? '<span class="gcell__fav">★</span>' : ''}${esc(s.title)}</div>
          </div>`;
        })
        .join('');
      return `<div class="grid__col">
        <div class="grid__head">第${esc(room)}会場</div>
        <div class="grid__body" style="height:${height}px">${cells}</div>
      </div>`;
    })
    .join('');

  return `<div class="grid">
    <div class="grid__axis">
      <div class="grid__head"></div>
      <div class="grid__body" style="height:${height}px">${ticks.join('')}</div>
    </div>
    <div class="grid__cols">${columns}
      ${
        showNow
          ? `<div class="grid__now" style="top:${(nowMin - from) * PX_PER_MIN + 30}px"></div>`
          : ''
      }
    </div>
  </div>`;
}

// The list is rendered in chunks so that a 200-hit search does not build the
// whole DOM up front on a phone.
const PAGE_SIZE = 30;
let lazy = { rows: [], terms: [], drawn: 0, lastSlot: null, observer: null };

function chunkHtml(rows, terms, startSlot) {
  const out = [];
  let currentSlot = startSlot;
  for (const s of rows) {
    if (lazy.slots) {
      const slot = s.start ?? '日時未定';
      if (slot !== currentSlot) {
        currentSlot = slot;
        out.push(`<div class="slot" data-slot="${esc(slot)}">${esc(slot)}</div>`);
      }
    }
    out.push(sessionCard(s, terms, liveStateOf(s), !lazy.slots));
  }
  return { html: out.join(''), lastSlot: currentSlot };
}

function drawMore() {
  const next = lazy.rows.slice(lazy.drawn, lazy.drawn + PAGE_SIZE);
  if (!next.length) return false;
  const { html, lastSlot } = chunkHtml(next, lazy.terms, lazy.lastSlot);
  lazy.lastSlot = lastSlot;
  lazy.drawn += next.length;
  const sentinel = els.list.querySelector('#sentinel');
  if (sentinel) sentinel.insertAdjacentHTML('beforebegin', html);
  else els.list.insertAdjacentHTML('beforeend', html);
  return lazy.drawn < lazy.rows.length;
}

function renderRows(rows, terms, slots) {
  lazy.observer?.disconnect();
  lazy = { rows, terms, drawn: 0, lastSlot: null, slots, observer: lazy.observer };
  const first = rows.slice(0, PAGE_SIZE);
  const { html, lastSlot } = chunkHtml(first, terms, null);
  lazy.drawn = first.length;
  lazy.lastSlot = lastSlot;
  const more = rows.length > first.length;
  setTimeout(() => {
    const sentinel = els.list.querySelector('#sentinel');
    if (!sentinel) return;
    if (!lazy.observer) {
      lazy.observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((x) => x.isIntersecting)) {
            const hasMore = drawMore();
            if (!hasMore) {
              const s = els.list.querySelector('#sentinel');
              if (s) s.remove();
            }
          }
        },
        { rootMargin: '600px 0px' },
      );
    }
    lazy.observer.observe(sentinel);
  }, 0);
  return html + (more ? '<div id="sentinel" class="sentinel">読み込み中…</div>' : '');
}

/** Is the currently shown day the day we are actually living through? */
function viewingToday() {
  const today = todayIso(state.now);
  return (state.meta.days ?? []).some((d) => d.date === today && d.day === state.day);
}

/** Jump to the current moment: the red line in grid view, the live card in list view. */
function jumpToNow() {
  state.now = new Date();
  if (state.view === 'grid' && state.day !== 'fav' && !state.query.trim()) {
    render();
    const line = els.list.querySelector('.grid__now');
    const target = line ?? els.list.querySelector('.gcell');
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  const nowMin = minutesNow(state.now);
  // Make sure the target is actually drawn before scrolling to it.
  let guard = 0;
  while (
    lazy.drawn < lazy.rows.length &&
    guard++ < 20 &&
    (lazy.rows[lazy.drawn - 1]?.startMin ?? 0) < nowMin
  ) {
    drawMore();
  }
  const target =
    els.list.querySelector('.card--live') ??
    els.list.querySelector('.card:not(.card--past)') ??
    els.list.querySelector('.card');
  target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

let scrolledOnce = false;
function scrollToNow(searching) {
  if (searching || scrolledOnce) return;
  const today = todayIso(state.now);
  const isToday = (state.meta.days ?? []).some((d) => d.date === today && d.day === state.day);
  if (!isToday) return;
  const live = els.list.querySelector('.card--live') ?? els.list.querySelector('.card:not(.card--past)');
  if (live) {
    scrolledOnce = true;
    requestAnimationFrame(() => live.scrollIntoView({ block: 'center' }));
  }
}

// ---------------------------------------------------------------- detail

function openSheet(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  const speakers = (s.speakers ?? [])
    .map(
      (x) => `<div class="detail__speaker">
        <div class="detail__speaker-name">${esc(x.name)}</div>
        <div class="detail__speaker-company">${esc(x.company)}</div>
        ${x.profile ? `<p>${esc(x.profile)}</p>` : ''}
        ${x.message ? `<p>${esc(x.message)}</p>` : ''}
      </div>`,
    )
    .join('');
  const fav = state.favs.has(s.id);
  els.sheetBody.innerHTML = `<div class="detail__top">
    <div class="detail__head">
      ${s.category ? `<span class="cat cat-${esc(s.category)}">${esc(s.category)}</span>` : ''}
      ${s.liveStream ? '<span class="tag tag--on">配信あり</span>' : ''}
      ${s.archive ? '<span class="tag">アーカイブ</span>' : ''}
      ${s.askSpeaker ? '<span class="tag">ASK the Speaker</span>' : ''}
      ${s.interpreted ? '<span class="tag">通訳</span>' : ''}
      ${s.photoOk ? '<span class="tag">撮影OK</span>' : ''}
      ${s.snsOk ? '<span class="tag">SNS OK</span>' : ''}
      ${s.cedil ? '<span class="tag">資料あり予定</span>' : ''}
    </div>
    <h2 class="detail__title" id="sheet-title">${esc(s.title)}</h2>
    <p class="detail__meta">
      ${s.date ? `${dayLabel(s.date)} ` : '日時未定 '}${esc(s.start ?? '')}${s.end ? '–' + esc(s.end) : ''}
      ${s.room ? ` · 第${esc(s.room)}会場` : ''} · ${esc(s.formatLabel ?? '')}
    </p>
  </div>
  <div class="detail__scroll detail">
    ${s.description ? `<h3>セッションの内容</h3><p>${esc(s.description)}</p>` : ''}
    ${s.takeaway ? `<h3>受講して得られるもの</h3><p>${esc(s.takeaway)}</p>` : ''}
    ${s.expectedSkill ? `<h3>受講対象</h3><p>${esc(s.expectedSkill)}</p>` : ''}
    ${s.difficulty?.label ? `<h3>難易度</h3><p>${esc(s.difficulty.label)}${
      s.difficulty.note ? `（${esc(s.difficulty.note)}）` : ''
    }</p>` : ''}
    ${s.keywords?.length ? `<h3>キーワード</h3><p>${esc(s.keywords.join(' / '))}</p>` : ''}
    ${speakers ? `<h3>登壇者</h3>${speakers}` : ''}
  </div>
  <div class="sheet__footer">
    ${s.url ? `<a class="btn" href="${esc(s.url)}" target="_blank" rel="noopener">公式ページ</a>` : ''}
    <button type="button" class="btn btn--star ${fav ? 'is-fav' : ''}" data-star="${esc(s.id)}"
      aria-pressed="${fav}" aria-label="マイプラン">${fav ? '★' : '☆'}</button>
    <button type="button" class="btn btn--close" data-close aria-label="閉じる">✕</button>
  </div>`;
  els.sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  els.sheet.querySelector('.sheet__panel').scrollTop = 0;
  // Let the phone's back gesture close the sheet instead of leaving the page.
  if (!history.state?.sheet) history.pushState({ sheet: id }, '');
}

function closeSheet(fromPop) {
  els.sheet.hidden = true;
  document.body.style.overflow = '';
  if (!fromPop && history.state?.sheet) history.back();
}

function toggleFav(id) {
  if (state.favs.has(id)) state.favs.delete(id);
  else state.favs.add(id);
  saveFavs();
  render();
  if (!els.sheet.hidden) openSheet(id);
}

// ---------------------------------------------------------------- events

function setViewLabel() {
  const grid = state.view === 'grid';
  els.view.setAttribute('aria-pressed', String(grid));
  els.viewList.setAttribute('aria-pressed', String(!grid));
}

function setView(next) {
  if (state.view === next) return;
  state.view = next;
  setViewLabel();
  try {
    localStorage.setItem(STORE_VIEW, state.view);
  } catch { /* ignore */ }
  scrolledOnce = false;
  window.scrollTo({ top: 0 });
  render();
}

function bind() {
  let timer = null;
  els.q.addEventListener('input', () => {
    state.query = els.q.value;
    els.clear.hidden = !state.query;
    clearTimeout(timer);
    timer = setTimeout(render, 120);
  });
  els.q.addEventListener('search', () => {
    state.query = els.q.value;
    render();
  });
  els.clear.addEventListener('click', () => {
    state.query = '';
    els.q.value = '';
    els.clear.hidden = true;
    els.q.focus();
    render();
  });

  els.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-day]');
    if (!btn) return;
    const v = btn.dataset.day;
    state.day = v === 'fav' ? 'fav' : Number(v);
    scrolledOnce = false;
    window.scrollTo({ top: 0 });
    render();
  });

  const toggleFilters = () => {
    const open = els.filters.hidden;
    els.filters.hidden = !open;
    els.filtersFloat.setAttribute('aria-pressed', String(open));
  };
  els.filtersFloat.addEventListener('click', toggleFilters);

  // Tapping outside the filter sheet closes it. Ignore clicks whose target was
  // already removed from the DOM by a re-render.
  document.addEventListener('click', (e) => {
    if (els.filters.hidden || !e.target.isConnected) return;
    if (e.target.closest('#filters') || e.target.closest('#btn-filters-float')) return;
    els.filters.hidden = true;
    els.filtersFloat.setAttribute('aria-pressed', 'false');
  });

  els.q.addEventListener('focus', () => document.body.classList.add('kb-open'));
  els.q.addEventListener('blur', () => document.body.classList.remove('kb-open'));

  els.filters.addEventListener('change', (e) => {
    if (e.target.id === 'sel-cat') state.cat = e.target.value;
    else if (e.target.id === 'sel-room') state.room = e.target.value;
    else return;
    render();
  });

  els.filters.addEventListener('click', (e) => {
      const tag = e.target.closest('[data-tag]');
    const reset = e.target.closest('[data-reset]');
    if (e.target.closest('[data-close-filters]')) {
      els.filters.hidden = true;
      els.btnFilters.setAttribute('aria-expanded', 'false');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (tag) {
      // Toggle in place: rebuilding the sheet would lose the scroll position
      // and make picking several keywords in a row annoying.
      const v = tag.dataset.tag;
      if (state.tags.has(v)) state.tags.delete(v);
      else state.tags.add(v);
      tag.setAttribute('aria-pressed', String(state.tags.has(v)));
      render();
      return;
    }
    if (reset) {
      state.cat = '';
      state.room = '';
      state.tags.clear();
      renderFilters();
      render();
    }
  });

  $('#btn-now').addEventListener('click', jumpToNow);

  els.btnMenu.addEventListener('click', () => {
    const open = els.menu.hidden;
    els.menu.hidden = !open;
    els.btnMenu.setAttribute('aria-expanded', String(open));
  });

  els.menuFilters.addEventListener('click', () => {
    els.menu.hidden = true;
    els.btnMenu.setAttribute('aria-expanded', 'false');
    els.filters.hidden = false;
    els.filtersFloat.setAttribute('aria-pressed', 'true');
  });

  els.fav.addEventListener('click', () => {
    state.day = state.day === 'fav' ? (state.meta.days?.[0]?.day ?? 1) : 'fav';
    state.query = '';
    els.q.value = '';
    els.clear.hidden = true;
    scrolledOnce = false;
    window.scrollTo({ top: 0 });
    render();
  });

  document.addEventListener('click', (e) => {
    if (els.menu.hidden) return;
    if (e.target.closest('#menu') || e.target.closest('#btn-menu')) return;
    els.menu.hidden = true;
    els.btnMenu.setAttribute('aria-expanded', 'false');
  });

  els.view.addEventListener('click', () => setView('grid'));
  els.viewList.addEventListener('click', () => setView('list'));

  // Long-press a card to star it without aiming for the small ☆.
  let pressTimer = null;
  let pressFired = false;
  const cancelPress = () => {
    clearTimeout(pressTimer);
    pressTimer = null;
  };
  els.list.addEventListener(
    'touchstart',
    (e) => {
      const card = e.target.closest('[data-id]');
      if (!card || e.target.closest('[data-star]')) return;
      const id = card.dataset.id;
      pressFired = false;
      pressTimer = setTimeout(() => {
        pressFired = true;
        navigator.vibrate?.(18);
        toggleFav(id);
      }, 460);
    },
    { passive: true },
  );
  els.list.addEventListener('touchmove', cancelPress, { passive: true });
  els.list.addEventListener('touchend', cancelPress);
  els.list.addEventListener('touchcancel', cancelPress);

  els.list.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('[data-id]');
    if (!card) return;
    e.preventDefault();
    toggleFav(card.dataset.id);
  });

  els.list.addEventListener('click', (e) => {
    if (pressFired) {
      pressFired = false;
      return;
    }
    const star = e.target.closest('[data-star]');
    if (star) {
      e.stopPropagation();
      toggleFav(star.dataset.star);
      return;
    }
    const card = e.target.closest('[data-id]');
    if (card) openSheet(card.dataset.id);
  });

  els.list.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('[data-id]');
    if (card) {
      e.preventDefault();
      openSheet(card.dataset.id);
    }
  });

  els.sheet.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeSheet();
    const star = e.target.closest('[data-star]');
    if (star) toggleFav(star.dataset.star);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.sheet.hidden) closeSheet();
  });

  window.addEventListener('popstate', () => {
    if (!els.sheet.hidden) closeSheet(true);
  });

  // Swipe the sheet down to dismiss it, like a native bottom sheet.
  const panel = els.sheet.querySelector('.sheet__panel');
  let dragFrom = null;
  panel.addEventListener(
    'touchstart',
    (e) => {
      dragFrom = panel.scrollTop <= 0 ? e.touches[0].clientY : null;
    },
    { passive: true },
  );
  panel.addEventListener(
    'touchmove',
    (e) => {
      if (dragFrom == null) return;
      const dy = e.touches[0].clientY - dragFrom;
      panel.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
    },
    { passive: true },
  );
  panel.addEventListener('touchend', (e) => {
    if (dragFrom == null) return;
    const dy = (e.changedTouches[0]?.clientY ?? dragFrom) - dragFrom;
    panel.style.transform = '';
    dragFrom = null;
    if (dy > 110) closeSheet();
  });

}

// ---------------------------------------------------------------- boot

async function boot() {
  loadFavs();
  try {
    const savedView = localStorage.getItem(STORE_VIEW);
    if (savedView === 'grid') state.view = 'grid';
  } catch { /* ignore */ }
  setViewLabel();

  const [sessions, meta] = await Promise.all([
    fetch('./data/sessions.json').then((r) => r.json()),
    fetch('./data/meta.json').then((r) => r.json()),
  ]);
  state.sessions = sessions;
  state.meta = meta;
  state.index = buildIndex(sessions);
  buildTagCloud();

  // Default to today when the conference is running.
  const today = todayIso(state.now);
  const match = (meta.days ?? []).find((d) => d.date === today);
  if (match) state.day = match.day;

  readHash();
  els.q.value = state.query;
  els.clear.hidden = !state.query;

  renderFilters();
  bind();
  render();

  // Sticky time headings need to know how tall the app bar currently is, and
  // the page needs to reserve room for the bottom bar.
  const appbar = document.querySelector('.appbar');
  const bottombar = document.querySelector('.bottombar');
  const syncBars = () => {
    const root = document.documentElement.style;
    root.setProperty('--appbar-h', `${appbar.offsetHeight}px`);
    root.setProperty('--bottombar-h', `${bottombar.offsetHeight}px`);
  };
  syncBars();
  new ResizeObserver(syncBars).observe(appbar);
  new ResizeObserver(syncBars).observe(bottombar);

  // Keep the bottom bar above the on-screen keyboard.
  const vv = window.visualViewport;
  if (vv) {
    const trackKeyboard = () => {
      const overlap = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
      document.documentElement.style.setProperty('--kb', `${Math.round(overlap)}px`);
    };
    vv.addEventListener('resize', trackKeyboard);
    vv.addEventListener('scroll', trackKeyboard);
    trackKeyboard();
  }

  const stamp = meta.sourceLastModified ? new Date(meta.sourceLastModified) : null;
  const note = `セッション ${meta.total} 件 · データ ${
    stamp ? stamp.toLocaleString('ja-JP') : '不明'
  } 時点`;
  els.footMeta.textContent = note;
  els.menuNote.textContent = note;

  const showOffline = () => {
    els.offline.hidden = navigator.onLine;
  };
  window.addEventListener('online', showOffline);
  window.addEventListener('offline', showOffline);
  showOffline();

  // Skip the worker while developing on localhost: a stale shell cache makes
  // every edit invisible. Offline support still gets verified on the deployed URL.
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && (!isLocal || location.search.includes('sw'))) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline support is optional */ });
  }
}

boot().catch((err) => {
  els.list.innerHTML = `<div class="empty">データを読み込めなかった<div class="empty__hint">
    ${esc(err.message)}</div></div>`;
});
