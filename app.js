import {
  buildIndex,
  search,
  highlightTerms,
  detectIntent,
  detectCompany,
  normalize,
} from './search.js';

const $ = (sel) => document.querySelector(sel);

const CURRENT_YEAR = '2026';

const state = {
  sessions: [],
  meta: null,
  index: [],
  day: 1,
  query: '',
  cat: '',
  rooms: new Set(),
  tags: new Set(),
  flags: new Map(),
  favs: new Set(),
  tagCloud: [],
  view: 'list',
  favDay: null,
  searchDay: null,
  clashes: new Set(),
  scrollMemory: {},
  year: CURRENT_YEAR,
  years: [],
  now: null, // set from nowJst() at boot
};

// The address we were opened at, kept before writeHash() rewrites it.
const entryUrl = location.href;

const STORE_FAV = 'cedec2026.favs';
const STORE_VIEW = 'cedec2026.view';
const STORE_THEME = 'cedec2026.theme';
const STORE_SEEN = 'cedec2026.seen';

const els = {
  list: $('#list'),
  tabs: $('#tabs'),
  q: $('#q'),
  clear: $('#btn-clear'),
  filters: $('#filters'),
  status: $('#status'),
  sheet: $('#sheet'),
  sheetBody: $('#sheet-body'),
  view: $('#btn-view'),
  viewList: $('#btn-view-list'),
  viewCompact: $('#btn-view-compact'),
  menu: $('#menu'),
  btnMenu: $('#btn-menu'),
  menuNote: $('#menu-note'),
  fav: $('#btn-fav-bottom'),
  favCount: $('#fav-count-bottom'),
  filtersFloat: $('#btn-filters-float'),
  offline: $('#offline'),
};

// ---------------------------------------------------------------- utilities

const gridView = () => state.view === 'grid';

// "個人" or "フリーランス" is not a company: searching for it leads nowhere, so
// those speakers get a search on their own name instead.
const GENERIC_AFFILIATION = [
  '個人',
  '個人事業主',
  'フリーランス',
  'freelance',
  '無所属',
  'independent',
  'indie',
];
const isGenericAffiliation = (company) => {
  const c = normalize(company).replace(/[（(].*$/, '').trim();
  return GENERIC_AFFILIATION.some((g) => c === normalize(g) || c.startsWith(normalize(g)));
};

/** Where a speaker's affiliation should link to. */
function speakerSearchUrl(speaker) {
  const generic = !speaker.company || isGenericAffiliation(speaker.company);
  const q = generic ? `${speaker.name} ゲーム 開発` : `${speaker.company} 公式`;
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`;
}

/** True while the detail sheet owns a history entry of its own. */
let sheetPushed = false;

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Make the addresses written inside a session's own text tappable — entry
 * forms, past sessions, demo videos. Only what the text already says; nothing
 * is guessed.
 */
function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<>"）」』]+/g, (raw) => {
    const url = raw.replace(/[.,。、）)」』]+$/, '');
    const tail = raw.slice(url.length);
    return `<a href="${url}" target="_blank" rel="noopener">${url}</a>${tail}`;
  });
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

/**
 * "Now" in Japan Standard Time, whatever the device is set to. The schedule is
 * published in JST, so a traveller's phone on another timezone (or one with a
 * wrong setting) must not shift which session counts as happening now.
 */
function nowJst() {
  const d = new Date();
  return new Date(d.getTime() + (d.getTimezoneOffset() + 540) * 60000);
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
  // During the conference a reload always lands on today: an address left over
  // from yesterday is never what you want while standing in the venue.
  const today = (state.meta?.days ?? []).find((d) => d.date === todayIso(state.now));
  if (today && state.day !== 'fav') state.day = today.day;
  if (h.has('q')) state.query = h.get('q');
  if (h.has('c')) state.cat = h.get('c');
  if (h.has('r')) state.rooms = new Set(h.get('r').split(',').filter(Boolean));
  if (h.has('t')) state.tags = new Set(h.get('t').split(',').filter(Boolean));
  // A shared session link beats the day rules above: open that session, and
  // show the day it is actually on.
  const wanted = h.get('s');
  const target = wanted ? state.sessions.find((x) => x.id === wanted) : null;
  if (target) state.day = target.day;
  return target?.id ?? null;
}

function writeHash() {
  const h = new URLSearchParams();
  h.set('d', String(state.day));
  if (state.query) h.set('q', state.query);
  if (state.cat) h.set('c', state.cat);
  if (state.rooms.size) h.set('r', [...state.rooms].join(','));
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
    const active = state.day === 'fav' ? state.favDay === d.day : state.day === d.day;
    // Stay usable while searching: the tabs still switch days, and in grid view
    // they pick which day's hits are laid out.
    const selected = searching && !gridView() ? state.searchDay === d.day : active;
    return `<button type="button" class="tab ${isToday ? 'tab--today' : ''}" role="tab"
      data-day="${d.day}" aria-selected="${selected}"
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

/** Year switcher in the menu. Past years are archive-only (no abstracts). */
function renderYearMenu() {
  const box = $('#menu-years');
  if (!box) return;
  const options = state.years
    .map(
      (y) =>
        `<option value="${y.year}" ${y.year === state.year ? 'selected' : ''}>CEDEC ${y.year}${
          y.archiveOnly ? '（アーカイブ）' : ''
        } · ${y.total ?? '-'}件</option>`,
    )
    .join('');
  box.innerHTML = `<select class="select" id="sel-year" aria-label="開催年">${options}</select>`;
  $('#sel-year').addEventListener('change', (e) => {
    const y = e.target.value;
    location.href = y === CURRENT_YEAR ? './' : `./?year=${y}`;
  });
}

// Flag filters. Each entry tests one session; the UI shows both the "yes" and
// the "no" side because either can decide whether a talk is worth attending.
// Each chip cycles: off -> only "yes" -> only "no" -> off. Most sessions allow
// photos, so hunting for the exceptions matters as much as the other way round.
const FLAG_FILTERS = [
  // 撮影 / SNS: the official session page renders these as a lit or unlit icon
  // under "写真撮影 / SNS投稿", so false really does mean not allowed.
  {
    key: 'photo',
    label: '撮影',
    get: (s) => Boolean(s.photoOk),
    noMark: '✕',
    noNote: '公式ページで撮影アイコンが点いていないもの',
  },
  {
    key: 'sns',
    label: 'SNS',
    get: (s) => Boolean(s.snsOk),
    noMark: '✕',
    noNote: '公式ページで SNS アイコンが点いていないもの',
  },
  // 資料 / ASK: not shown on the official page at all, so the absence of the
  // flag says nothing beyond "not stated".
  {
    key: 'doc',
    label: '資料',
    get: (s) => Boolean(s.cedil || s.cedilUrl),
    noMark: '：表記なし',
    noNote: '公式に記載なし',
  },
  // Streaming is the one flag with a real "not stated" case, so ○ and ✕ both
  // require an explicit note rather than treating silence as a no.
  {
    key: 'live',
    label: '配信',
    get: (s) => s.streamState === 'ok',
    excludes: (s) => s.streamState === 'ng',
    noMark: '✕',
    noNote: '公式に「配信NG」と明記',
  },
  {
    key: 'ask',
    label: 'ASK',
    get: (s) => Boolean(s.askSpeaker),
    noMark: '：表記なし',
    noNote: '公式に記載なし',
  },
];

function renderFilters() {
  const flagChips = FLAG_FILTERS.map((f) => {
    const mode = state.flags.get(f.key);
    const suffix = mode === '+' ? '○' : mode === '-' ? (f.noMark ?? '✕') : '';
    const note = mode === '-' ? ` title="${f.label}: ${f.noNote ?? ''}"` : '';
    return `<button type="button" class="chip chip--tri ${mode === '-' ? 'is-no' : ''}"
      data-flag="${f.key}" aria-pressed="${Boolean(mode)}"${note}>${f.label}${suffix}</button>`;
  }).join('');

  const cats = state.meta.categories ?? [];
  const catOptions = cats
    .map(
      (c) => `<option value="${esc(c.code)}" ${state.cat === c.code ? 'selected' : ''}>${esc(
        c.label || c.code,
      )}</option>`,
    )
    .join('');
  const roomItems = (state.meta.rooms ?? [])
    .map(
      (r) => `<label class="dropdown__item"><input type="checkbox" data-room="${esc(r)}"
        ${state.rooms.has(r) ? 'checked' : ''}> 第${esc(r)}会場</label>`,
    )
    .join('');
  const roomSummary = state.rooms.size
    ? `会場：第${[...state.rooms].sort((a, b) => Number(a) - Number(b)).join('・')}会場`
    : '会場：すべて';
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
    <div class="filters__group filters__foot">
      <div class="filters__label">キーワード<span class="filters__count" id="filters-count"></span></div>
      <button type="button" class="iconbtn iconbtn--sm" data-reset
              aria-label="絞り込みを解除" title="絞り込みを解除">🗑</button>
    </div>
    <div class="filters__group filters__group--tight">
      <div class="tagcloud">${cloud}</div>
    </div>
    <div class="filters__group">
      <div class="filters__label">条件</div>
      <div class="filters__chips">${flagChips}</div>
    </div>
    <div class="filters__row">
      <select id="sel-cat" class="select" aria-label="カテゴリ">
        <option value="">カテゴリ：すべて</option>${catOptions}</select>
      <details class="dropdown" id="room-dropdown">
        <summary class="select">${esc(roomSummary)}</summary>
        <div class="dropdown__menu">${roomItems}</div>
      </details>
    </div>`;
}

function sessionCard(s, terms, liveState, showDate) {
  const cat =
    s.category && s.category !== 'カテゴリなし'
      ? `<span class="cat cat-${esc(s.category)}">${esc(s.category)}</span>`
      : '';
  const room = s.room
    ? `<span class="card__room" data-room="${esc(s.room)}会場">第${esc(s.room)}会場</span>`
    : '';
  const time = s.start
    ? `<span class="card__time"><strong>${esc(s.start)}</strong><span class="card__time-end">–${esc(
        s.end ?? '',
      )}</span></span>`
    : '<span class="card__time">日時未定</span>';
  const format = s.format ? `<span class="card__format">${esc(s.format)}</span>` : '';
  // Whether you may photograph the talk and whether slides get published
  // drives the decision, so both are shown for every session — but only for
  // years where the source actually carries the flags. Archive years have no
  // such data, and showing ✕ there would be a lie.
  // 撮影 / SNS / 配信: the official feed states these, so both sides are shown.
  // 資料 / ASK: no "no" exists in the data, so only the positive is shown.
  const mark = (label, on) =>
    `<span class="mk ${on ? 'mk--ok' : 'mk--ng'}" title="${label}${on ? 'OK' : 'NG'}">${label}${
      on ? '○' : '✕'
    }</span>`;
  const marks = [
    mark('撮影', s.photoOk),
    mark('SNS', s.snsOk),
    s.streamState ? mark('配信', s.streamState === 'ok') : '',
    s.cedil || s.cedilUrl ? '<span class="mk mk--ok" title="講演資料あり">資料○</span>' : '',
    s.askSpeaker ? '<span class="mk mk--ask" title="ASK the Speaker あり">ASK</span>' : '',
  ]
    .filter(Boolean)
    .join('');
  const badge =
    liveState === 'live'
      ? '<span class="tag tag--live">開催中</span>'
      : liveState === 'next'
        ? '<span class="tag tag--next">まもなく</span>'
        : '';
  const speakers = (s.speakers ?? [])
    .map(
      (x) =>
        // The company name is plain text and only the ↗ is tappable: the name
        // ran the full width of the line, so a thumb aimed at the card kept
        // landing on it.
        `<span class="sp"><span class="sp__name">${highlight(x.name, terms)}</span>${
          x.company
            ? `<span class="sp__co">${highlight(x.company, terms)}<a class="sp__go"
                 href="${speakerSearchUrl(x)}" target="_blank" rel="noopener"
                 title="${esc(x.company)} を検索" aria-label="${esc(x.company)} を検索">↗</a></span>`
            : ''
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
  const clash = fav && state.clashes?.has(s.id);
  return `<div class="card ${clash ? 'card--clash' : ''} cat-edge-${esc(s.category || 'none')} ${
    liveState === 'live' ? 'card--live' : ''
  } ${
    liveState === 'next' ? 'card--next' : ''
  } ${liveState === 'past' ? 'card--past' : ''} ${
    fav ? 'card--fav' : ''
  }" data-id="${esc(s.id)}" role="button" tabindex="0">
    <div class="card__head">${s.date ? `<span class="card__date">${dayLabel(s.date)}</span>` : ''}${time}${
      room ? ' · ' + room : ''
    }${cat ? ' · ' + cat : ''}${format ? ' · ' + format : ''} ${badge}${
      clash ? '<span class="tag tag--clash" title="同じ時間に他のお気に入りがあります">⚠ 時間かぶり</span>' : ''
    }${marks ? `<span class="marks">${marks}</span>` : ''}</div>
    <h2 class="card__title">${highlight(s.title, terms)}</h2>
    ${speakers ? `<p class="card__speakers">${speakers}</p>` : ''}
    ${gist ? `<p class="card__snippet">${highlight(gist, terms)}…</p>` : ''}
    <button type="button" class="card__star" data-star="${esc(s.id)}"
      aria-pressed="${fav}" aria-label="お気に入りに追加">${fav ? '★' : '☆'}</button>
  </div>`;
}

/**
 * Ids of starred sessions whose times overlap another starred session.
 * You cannot be in two rooms at once, so this is worth flagging.
 */
function findClashes() {
  const starred = state.sessions.filter(
    (s) => state.favs.has(s.id) && s.day != null && s.startMin != null && s.endMin != null,
  );
  const clashing = new Set();
  for (let i = 0; i < starred.length; i++) {
    for (let j = i + 1; j < starred.length; j++) {
      const a = starred[i];
      const b = starred[j];
      if (a.day !== b.day) continue;
      if (a.startMin < b.endMin && b.startMin < a.endMin) {
        clashing.add(a.id);
        clashing.add(b.id);
      }
    }
  }
  return clashing;
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
    if (state.rooms.size && !state.rooms.has(s.room)) return false;
    if (state.tags.size && !(s.keywords ?? []).some((k) => state.tags.has(k.trim()))) return false;
    for (const [key, mode] of state.flags) {
      const f = FLAG_FILTERS.find((x) => x.key === key);
      if (!f) continue;
      const no = f.excludes ?? ((x) => !f.get(x));
      if (mode === '+' ? !f.get(s) : !no(s)) return false;
    }
    if (intent?.categories?.length && !intent.categories.includes(s.category)) return false;
    if (intent?.level != null && s.difficulty?.level !== intent.level) return false;
    if (intent?.day != null && s.day !== intent.day) return false;
    if (intent?.band && (s.startMin == null || s.startMin < intent.band.from || s.startMin >= intent.band.to))
      return false;
    return true;
  });
}

function render() {
  // Refresh the clock on every draw so a page left open overnight still knows
  // which day and which session is current.
  state.now = nowJst();
  state.clashes = findClashes();
  const query = state.query.trim();
  const searching = query.length > 0;
  const terms = searching ? highlightTerms(query) : [];
  let notes = [];

  let rows;
  let eveningHtml = '';
  if (searching) {
    const intent = detectIntent(query, state.meta.categories);
    const hits = intent.rest ? search(intent.rest, state.index) : null;
    let picked;
    if (hits) {
      // Prefer results that contain every word typed; fall back to the ranked
      // list when nothing matches all of them.
      const full = hits.filter((h) => h.coverage >= 0.999);
      const used = full.length ? full : hits;
      if (full.length && full.length < hits.length) notes.push('すべての語を含む');
      picked = used.map((h) => ({ s: state.sessions[h.index], score: h.score }));
    } else {
      picked = state.sessions.map((s) => ({ s, score: 0 }));
    }
    const filtered = applyFilters(picked.map((p) => p.s), intent);
    const keep = new Set(filtered.map((s) => s.id));
    rows = picked.filter((p) => keep.has(p.s.id)).map((p) => p.s);

    // Naming a company narrows the result instead of merely boosting it. The
    // match is made against every session, not just the text hits: a nickname
    // like エニカラ never appears in the speaker list of ANYCOLOR itself.
    const company = detectCompany(query);
    if (company) {
      const belongs = (s) => {
        const hay = normalize((s.speakers ?? []).map((x) => `${x.company} ${x.name}`).join(' '));
        return company.some((c) => c.length >= 3 && hay.includes(c));
      };
      const named = state.sessions.filter(belongs);
      if (named.length) {
        const keepIds = new Set(named.map((s) => s.id));
        const ranked = rows.filter((s) => keepIds.has(s.id));
        rows = ranked.length ? ranked : named;
        notes.push(company[0]);
      }
    }

    if (intent.day) notes.push(`${intent.day}日目`);
    if (intent.band) notes.push(intent.band.label);
    if (intent.level != null) notes.push(intent.level === 1 ? '入門寄り' : '上級寄り');
    if (intent.categories.length) notes.push(intent.categories.join('/'));
    if (state.searchDay != null) {
      const dayRows = rows.filter((s) => s.day === state.searchDay);
      if (dayRows.length || rows.length) rows = dayRows;
      const d = (state.meta.days ?? []).find((x) => x.day === state.searchDay);
      if (d) notes.push(dayLabel(d.date));
    }
    els.status.textContent = `${state.searchDay == null ? '全日程から ' : ''}${rows.length}件${
      notes.length ? ' · ' + notes.join(' · ') : ''
    }`;
    if (gridView() && state.day !== 'fav') {
      // Keep the wall-clock view usable while searching: show the hits that
      // fall on the selected day.
      const dayHits = rows.filter((s) => s.day === state.day);
      els.list.innerHTML = dayHits.length
        ? renderGrid(dayHits)
        : `<div class="empty">この日には見つからなかった<div class="empty__hint">
            別の日を選ぶか、リスト表示に切り替えてみて</div></div>`;
    } else {
      els.list.innerHTML = rows.length
        ? renderRows(rows, terms, false)
        : `<div class="empty">見つからなかった<div class="empty__hint">
            言葉を減らすか、別の言い方を試してみて<br>例:「AI 効率化」「新人 育成」「描画 最適化」</div></div>`;
    }
  } else {
    const base =
      state.day === 'fav'
        ? state.sessions.filter(
            (s) => state.favs.has(s.id) && (state.favDay == null || s.day === state.favDay),
          )
        : state.sessions.filter((s) => s.day === state.day);
    rows = applyFilters(base, null);
    eveningHtml =
      state.day === 'fav' || state.cat || state.rooms.size || state.tags.size || state.flags.size
        ? ''
        : renderEvents(state.day);
    const narrowed = [];
    if (state.cat) narrowed.push(state.cat);
    if (state.rooms.size) narrowed.push(`第${[...state.rooms].join('・')}会場`);
    if (state.flags.size) {
      narrowed.push(
        [...state.flags]
          .map(([k, mode]) => {
            const f = FLAG_FILTERS.find((x) => x.key === k);
            return `${f?.label ?? k}${mode === '+' ? '○' : (f?.noMark ?? '✕')}`;
          })
          .join('・'),
      );
    }
    if (state.tags.size) narrowed.push([...state.tags].join('/'));
    if (state.day === 'fav' && state.clashes.size) {
      const shown = rows.filter((s) => state.clashes.has(s.id)).length;
      if (shown) narrowed.unshift(`⚠ ${shown}件が時間かぶり`);
    }
    els.status.textContent = `${rows.length}件${narrowed.length ? ' · ' + narrowed.join(' · ') : ''}`;
    if (gridView() && state.day !== 'fav') {
      // The board already places the evening events on the clock.
      els.list.innerHTML = rows.length ? renderGrid(rows) : emptyMessage();
    } else {
      els.list.innerHTML = (rows.length ? renderRows(rows, terms, true) : emptyMessage()) + eveningHtml;
    }
  }
  const gridMode = state.view === 'grid' && state.day !== 'fav';
  els.list.classList.toggle('list--grid', gridMode);
  els.list.classList.toggle('list--compact', state.view === 'compact');
  document.body.classList.toggle('view-grid', gridMode);

  const count = $('#filters-count');
  if (count) count.textContent = els.status.textContent;

  // Make it obvious at a glance that something is being filtered out.
  const activeFilters =
    (state.cat ? 1 : 0) + state.rooms.size + state.tags.size + state.flags.size;
  els.filtersFloat.classList.toggle('is-active', activeFilters > 0);
  els.filtersFloat.dataset.count = activeFilters > 0 ? String(activeFilters) : '';
  els.filtersFloat.setAttribute(
    'aria-label',
    activeFilters > 0 ? `絞り込み（${activeFilters}件の条件が有効）` : '絞り込み',
  );

  bindGridAxisLock(els.list.querySelector('.grid'));
  renderTabs();
  writeHash();
  scrollToNow(searching);
  const nowBtn = $('#btn-now');
  const canJump = viewingToday() && !searching && state.day !== 'fav';
  nowBtn.hidden = !canJump;
  nowBtn.textContent = '今';
}

/** Evening events (official Developers' Night plus the community meetups). */
function renderEvents(day) {
  if (state.year !== CURRENT_YEAR) return '';
  const list = (state.events?.events ?? []).filter((e) => e.day === day);
  if (!list.length) return '';
  const cards = list
    .map(
      (e) => `<a class="evcard ${e.official ? 'evcard--official' : ''}"
        href="${esc(e.url)}" target="_blank" rel="noopener">
        <div class="evcard__head">${e.official ? '公式イベント' : '非公式'} ·
          ${esc(e.start)}–${esc(e.end)}</div>
        <div class="evcard__title">${esc(e.title)}</div>
        <div class="evcard__place">@ ${esc(e.place)}${e.note ? ` · ${esc(e.note)}` : ''}</div>
      </a>`,
    )
    .join('');
  return `<div class="evsection">
    <div class="slot slot--ev">夜のイベント</div>
    ${cards}
    <p class="evsection__note">${esc(state.events.note ?? '')}
      出典: <a href="${esc(state.events.source ?? '')}" target="_blank" rel="noopener">CEDEC非公式タイムテーブル</a></p>
  </div>`;
}

function emptyMessage() {
  if (state.day === 'fav')
    return `<div class="empty">お気に入りは空っぽ<div class="empty__hint">
      カードの右下の ☆ を押すと、ここに集まるよ</div></div>`;
  return `<div class="empty">条件に合うセッションが無い<div class="empty__hint">
    絞り込みを解除してみて</div></div>`;
}

// Wall-clock grid: rooms across, time down. Useful on a tablet or when the
// phone is turned sideways.
const PX_PER_MIN = 3.1;

/** "昼休み（13:00 - 13:40）" / "20分休憩（12:10 - 12:30）" */
function breakLabel(b) {
  const head = b.label === '昼休み' ? '昼休み' : `${b.to - b.from}分休憩`;
  return `${head}（${b.start} - ${b.end}）`;
}

function renderGrid(rows) {
  const dated = rows.filter((s) => s.startMin != null && s.room);
  if (!dated.length) return emptyMessage();

  const rooms = [...new Set(dated.map((s) => s.room))].sort((a, b) => Number(a) - Number(b));

  // Evening events are laid out on the same clock, spread across the full width
  // below the last session.
  const toMin = (hhmm) => {
    const m = String(hhmm ?? '').match(/^(\d{1,2}):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const events =
    state.year === CURRENT_YEAR
      ? (state.events?.events ?? []).filter((e) => e.day === state.day && toMin(e.start) != null)
      : [];

  // One explicit column width shared by the header row and the board, so the
  // two can never drift apart. Wide screens fit every room; phones scroll.
  const boardWidth = els.list.clientWidth || window.innerWidth;
  const colWidth =
    boardWidth >= 1000
      ? Math.max(100, Math.floor((boardWidth - 47) / rooms.length))
      : 150;
  const from = Math.floor(Math.min(...dated.map((s) => s.startMin)) / 30) * 30;
  const lastSession = Math.max(...dated.map((s) => s.endMin ?? s.startMin + 60));
  const lastEvent = events.length ? Math.max(...events.map((e) => toMin(e.end) ?? 0)) : 0;
  const to = Math.ceil(Math.max(lastSession, lastEvent) / 30) * 30;
  const height = (to - from) * PX_PER_MIN;

  const ticks = [];
  for (let m = from; m <= to; m += 30) {
    const onHour = m % 60 === 0;
    ticks.push(`<div class="grid__tick ${onHour ? 'grid__tick--hour' : 'grid__tick--half'}"
      style="top:${(m - from) * PX_PER_MIN}px">${String(Math.floor(m / 60)).padStart(2, '0')}:${String(
      m % 60,
    ).padStart(2, '0')}</div>`);
  }

  const today = todayIso(state.now);
  const nowMin = minutesNow(state.now);
  const showNow =
    (state.meta.days ?? []).some((d) => d.date === today && d.day === state.day) &&
    nowMin >= from &&
    nowMin <= to;

  const breaks = (state.meta.breaks ?? [])
    .filter((b) => b.day === state.day && b.from >= from && b.to <= to)
    .map(
      (b) => `<div class="grid__break" style="top:${(b.from - from) * PX_PER_MIN}px;
        height:${(b.to - b.from) * PX_PER_MIN}px"><span>${esc(breakLabel(b))}</span></div>`,
    )
    .join('');

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
          } ${ls === 'past' ? 'gcell--past' : ''} ${fav ? 'gcell--fav' : ''} ${
            h < 74 ? 'gcell--tight' : ''
          }" style="top:${top}px;height:${h}px" data-id="${esc(s.id)}" role="button" tabindex="0">
            <div class="gcell__meta">${
              s.category && s.category !== 'カテゴリなし'
                ? `<span class="cat cat-${esc(s.category)}">${esc(s.category)}</span>`
                : ''
            }<span class="gmk ${s.photoOk ? '' : 'gmk--ng'}">撮影${s.photoOk ? '○' : '✕'}</span>
            <span class="gmk ${s.snsOk ? '' : 'gmk--ng'}">SNS${s.snsOk ? '○' : '✕'}</span>${
              s.streamState
                ? `<span class="gmk ${
                    s.streamState === 'ok' ? 'gmk--live' : 'gmk--ng'
                  }">配信${s.streamState === 'ok' ? '○' : '✕'}</span>`
                : ''
            }${s.cedil || s.cedilUrl ? '<span class="gmk">資料○</span>' : ''}${
              s.askSpeaker ? '<span class="gmk">ASK</span>' : ''
            }</div>
            <div class="gcell__title">${esc(s.title)}</div>
            <div class="gcell__co">${esc(
              (s.speakers ?? [])
                .map((x) => x.company || x.name)
                .filter(Boolean)
                .slice(0, 2)
                .join(' / '),
            )}</div>
            <button type="button" class="gcell__star" data-star="${esc(s.id)}"
              aria-pressed="${fav}" aria-label="お気に入り">${fav ? '★' : '☆'}</button>
          </div>`;
        })
        .join('');
      return `<div class="grid__col" style="width:${colWidth}px">
        <div class="grid__body" style="height:${height}px">${cells}</div>
      </div>`;
    })
    .join('');

  const eventBlocks = events
    .map((e, i) => {
      const start = toMin(e.start);
      const end = toMin(e.end) ?? start + 60;
      const width = 100 / events.length;
      return `<div class="gev ${e.official ? 'gev--official' : ''}"
        style="top:${(start - from) * PX_PER_MIN}px;height:${Math.max(
          (end - start) * PX_PER_MIN - 3,
          30,
        )}px;left:${(i * width).toFixed(3)}%;width:calc(${width.toFixed(3)}% - 4px)"
        data-event="${esc(e.url)}" role="button" tabindex="0">
        <div class="gev__head">${e.official ? '公式' : '非公式'} ${esc(e.start)}–${esc(e.end)}</div>
        <div class="gev__title">${esc(e.title)}</div>
        <div class="gev__place">@ ${esc(e.place)}</div>
      </div>`;
    })
    .join('');

  // The header row is a direct child of the scroller so that `position: sticky`
  // pins it reliably while the board scrolls in both directions. Both rows use
  // the same explicit column width, so they can never drift apart.
  const heads = rooms
    .map((room) => `<div class="grid__head" style="width:${colWidth}px">第${esc(room)}会場</div>`)
    .join('');

  return `<div class="grid">
    <div class="grid__headrow">
      <div class="grid__corner"></div>
      ${heads}
    </div>
    <div class="grid__panes">
      <div class="grid__axis" style="height:${height}px">${ticks.join('')}</div>
      <div class="grid__cols">${columns}${breaks}${eventBlocks}
        ${
          showNow ? `<div class="grid__now" style="top:${(nowMin - from) * PX_PER_MIN}px"></div>` : ''
        }
      </div>
    </div>
  </div>`;
}

// A day holds at most ~72 sessions and a search is capped at 80, so drawing
// everything up front is fast and avoids the stutter of loading while scrolling.
const PAGE_SIZE = 500;
let lazy = { rows: [], terms: [], drawn: 0, lastSlot: null, observer: null };

function chunkHtml(rows, terms, startSlot) {
  const out = [];
  let currentSlot = startSlot;
  for (const s of rows) {
    if (lazy.slots) {
      const slot = s.start ?? '日時未定';
      if (slot !== currentSlot) {
        currentSlot = slot;
        const gap = (state.meta.breaks ?? []).find(
          (b) => b.day === s.day && b.end === slot,
        );
        if (gap) out.push(`<div class="restbar">${esc(breakLabel(gap))}</div>`);
        const now = liveStateOf(s) === 'live';
        out.push(
          `<div class="slot ${now ? 'slot--now' : ''}" data-slot="${esc(slot)}">${esc(slot)}${
            now ? '<span class="slot__badge">いま</span>' : ''
          }</div>`,
        );
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
  state.now = nowJst();
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

/** Time label of the slot heading currently pinned at the top, if any. */
function currentTopSlot() {
  const top = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 110;
  let found = null;
  for (const slot of els.list.querySelectorAll('.slot')) {
    if (slot.getBoundingClientRect().top <= top + 8) found = slot.dataset.slot;
    else break;
  }
  return found;
}

/** Scroll to the same (or next available) time after a day switch. */
function restoreSlot(time) {
  if (!time) {
    window.scrollTo({ top: 0 });
    return;
  }
  const slots = [...els.list.querySelectorAll('.slot')];
  const target = slots.find((s) => s.dataset.slot >= time) ?? slots[slots.length - 1];
  if (!target) {
    window.scrollTo({ top: 0 });
    return;
  }
  const prev = document.documentElement.style.scrollBehavior;
  document.documentElement.style.scrollBehavior = 'auto';
  target.scrollIntoView({ block: 'start' });
  document.documentElement.style.scrollBehavior = prev;
}

/**
 * Lock the board to one axis per gesture. A diagonal swipe on a two-way
 * scroller otherwise drifts vertically while you are panning across rooms.
 * Vertical drags are left to the browser so they keep their momentum.
 */
function bindGridAxisLock(board) {
  if (!board || board.dataset.axisLock) return;
  board.dataset.axisLock = '1';
  let startX = 0;
  let startY = 0;
  let fromLeft = 0;
  let axis = null;

  board.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      fromLeft = board.scrollLeft;
      axis = null;
    },
    { passive: true },
  );

  board.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (!axis) {
        if (Math.abs(dx) + Math.abs(dy) < 12) return;
        axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
      }
      if (axis !== 'x') return;
      e.preventDefault();
      board.scrollLeft = fromLeft - dx;
    },
    { passive: false },
  );

  board.addEventListener('touchend', () => {
    axis = null;
  });
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

// A QR glyph rather than a generic share arrow: the button really does put a
// code on screen for someone else's camera.
const QR_ICON = `<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" fill="currentColor">
  <path d="M3 3h7v7H3V3zm2 2v3h3V5H5zM14 3h7v7h-7V3zm2 2v3h3V5h-3zM3 14h7v7H3v-7zm2 2v3h3v-3H5z"/>
  <path d="M14 14h3v3h-3zM18 18h3v3h-3zM18.5 14h2.5v2h-2.5zM14 18.5h2v2.5h-2z"/>
</svg>`;

const YT_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor">
  <path d="M22.5 7.2a2.7 2.7 0 0 0-1.9-1.9C18.9 4.8 12 4.8 12 4.8s-6.9 0-8.6.5A2.7 2.7 0 0 0 1.5 7.2
           C1 9 1 12 1 12s0 3 .5 4.8a2.7 2.7 0 0 0 1.9 1.9c1.7.5 8.6.5 8.6.5s6.9 0 8.6-.5a2.7 2.7 0 0 0
           1.9-1.9C23 15 23 12 23 12s0-3-.5-4.8zM9.8 15.3V8.7l5.7 3.3-5.7 3.3z"/>
</svg>`;

function openSheet(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  // No company URLs exist in the feed, so link to a search rather than guess a
  // domain and send people somewhere wrong.
  const companyLink = (sp) =>
    `<a class="detail__speaker-company" href="${speakerSearchUrl(sp)}" target="_blank"
       rel="noopener">${esc(sp.company)} <span class="detail__ext">↗</span></a>`;

  const speakers = (s.speakers ?? [])
    .map(
      (x) => `<div class="detail__speaker">
        <div class="detail__speaker-name">${esc(x.name)}</div>
        ${x.company ? companyLink(x) : ''}
        ${x.profile ? `<p>${esc(x.profile)}</p>` : ''}
        ${x.message ? `<p>${esc(x.message)}</p>` : ''}
      </div>`,
    )
    .join('');
  const fav = state.favs.has(s.id);
  // The official site puts a 視聴する button on every session except the ones
  // marked 配信NG — checked against all 221 pages, no exceptions. The address is
  // derived from the id, so no guessing is involved. It asks for a login.
  const viewUrl =
    state.meta?.archiveOnly || s.streamState === 'ng'
      ? ''
      : `https://cedec.cesa.or.jp/${state.year}/timetable/view/${encodeURIComponent(s.id)}`;
  // The same stream is public on the official channel, titled with the date and
  // the room ("CEDEC2026 基調講演 中継 【7/22(水) 第1会場】"). Searching the channel
  // for those two beats guessing a video id, and on a phone it hands off to the
  // YouTube app — where picture-in-picture works.
  const ytUrl =
    viewUrl && s.date && s.room
      ? `https://www.youtube.com/@cedecyoutube5093/search?query=${encodeURIComponent(
          `${Number(s.date.split('-')[1])}/${Number(s.date.split('-')[2])} 第${s.room}会場`,
        )}`
      : '';
  els.sheetBody.innerHTML = `<div class="detail__top">
    <div class="detail__head">
      ${s.category ? `<span class="cat cat-${esc(s.category)}">${esc(s.category)}</span>` : ''}
      ${s.liveStream ? '<span class="tag tag--on">配信あり</span>' : ''}
      ${s.archive ? '<span class="tag">アーカイブ</span>' : ''}
      ${s.askSpeaker ? '<span class="tag">ASK the Speaker</span>' : ''}
      ${s.interpreted ? '<span class="tag">通訳</span>' : ''}
      ${s.cedil ? '<span class="tag">資料あり予定</span>' : ''}
    </div>
    <p class="detail__meta">
      ${s.date ? `${dayLabel(s.date)} ` : '日時未定 '}${esc(s.start ?? '')}${s.end ? '–' + esc(s.end) : ''}
      ${s.room ? ` · 第${esc(s.room)}会場` : ''} · ${esc(s.formatLabel ?? '')}
    </p>
  </div>
  <div class="detail__scroll detail">
    <h2 class="detail__title" id="sheet-title">${esc(s.title)}</h2>
    ${
      state.meta?.archiveOnly
        ? `<p class="detail__notice">${esc(state.year)} 年のアーカイブです。
           説明文は公式ページ、資料は CEDiL のリンクから見られます。</p>`
        : ''
    }
    ${
      state.meta?.archiveOnly
        ? ''
        : `<h3>写真撮影 / SNS投稿</h3>
           <p class="detail__policy">
             <span class="mk ${s.photoOk ? 'mk--ok' : 'mk--ng'}">撮影${s.photoOk ? '○' : '✕'}</span>
             <span class="mk ${s.snsOk ? 'mk--ok' : 'mk--ng'}">SNS${s.snsOk ? '○' : '✕'}</span>
             <span class="detail__policy-note">公式サイトの表示に合わせています。SNS投稿がOKの
             セッションでも、全内容の文字起こしおよびそれに類する行為は禁止です。</span>
           </p>`
    }
    ${s.description ? `<h3>セッションの内容</h3><p>${linkify(s.description)}</p>` : ''}
    ${s.takeaway ? `<h3>受講して得られるもの</h3><p>${linkify(s.takeaway)}</p>` : ''}
    ${s.expectedSkill ? `<h3>受講対象</h3><p>${linkify(s.expectedSkill)}</p>` : ''}
    ${s.difficulty?.label ? `<h3>難易度</h3><p>${esc(s.difficulty.label)}${
      s.difficulty.note ? `（${esc(s.difficulty.note)}）` : ''
    }</p>` : ''}
    ${s.keywords?.length ? `<h3>キーワード</h3><p>${esc(s.keywords.join(' / '))}</p>` : ''}
    ${speakers ? `<h3>登壇者</h3>${speakers}` : ''}
  </div>
  <div class="sheet__footer">
    ${s.url ? `<a class="btn btn--sm" href="${esc(s.url)}" target="_blank" rel="noopener">公式</a>` : ''}
    ${
      viewUrl
        ? `<a class="btn btn--sm btn--watch" href="${esc(viewUrl)}" target="_blank" rel="noopener"
             title="公式の視聴ページ（CEDECのログインが必要）"><span aria-hidden="true">▶</span>視聴</a>`
        : ''
    }
    ${
      ytUrl
        ? `<a class="btn btn--sm btn--yt" href="${esc(ytUrl)}" target="_blank" rel="noopener"
             aria-label="YouTube でこの会場の配信を探す"
             title="公式YouTubeでこの日・この会場の配信を探す（アプリが開けばPiPが使える）">${YT_ICON}</a>`
        : ''
    }
    ${
      s.cedilUrl
        ? `<a class="btn btn--sm" href="${esc(s.cedilUrl)}" target="_blank" rel="noopener">資料</a>`
        : ''
    }
    <span class="sheet__spacer"></span>
    <button type="button" class="btn btn--qr" data-share="${esc(s.id)}"
      aria-label="この講演をQRで渡す" title="QRで渡す">${QR_ICON}</button>
    <button type="button" class="btn btn--star ${fav ? 'is-fav' : ''}" data-star="${esc(s.id)}"
      aria-pressed="${fav}" aria-label="お気に入り">${fav ? '★' : '☆'}</button>
    <button type="button" class="btn btn--close" data-close aria-label="閉じる">✕</button>
  </div>`;
  els.sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  els.sheet.querySelector('.sheet__panel').scrollTop = 0;
  // Let the phone's back gesture close the sheet instead of leaving the page.
  if (!sheetPushed) {
    history.pushState({ sheet: id }, '');
    sheetPushed = true;
  }
}

const HELP_ROWS = [
  ['一覧を左右にスワイプ', '7/22 → 7/23 → 7/24 → ★お気に入り を行き来'],
  ['カードをタップ', '詳細をひらく'],
  ['カードを長押し / ★', 'お気に入りに入れる・外す'],
  ['詳細を左右にフリック', 'とじる（下にフリック・背景タップ・端末の戻るでも可）'],
  ['上から引っ張る', '最新のデータに更新'],
  ['☰ ▤ ▦（右上）', 'リスト / コンパクト / タイムテーブル の切り替え'],
  ['↑ ∧ ∨ 今（右下）', '一番上へ / 前の時間帯 / 次の時間帯 / 今の時間へ'],
  ['🔍 検索', '略称でも引けます（サイゲ・バンナム・にんてん など）。'
    + '「サイゲのAIの話」のような書き方もOK'],
  ['▼ 絞り込み', 'カテゴリ・会場（複数可）・キーワード・撮影/資料/SNS/配信の条件。'
    + '条件が効いているとアイコンが光ります'],
  ['★お気に入り', '同じ時間に重なる登録があると「⚠ 時間かぶり」が出ます'],
  ['詳細の QR ボタン', 'その講演の QR が出ます。友だちにカメラを向けてもらえば同じ画面が開きます'],
  ['詳細の「視聴」', '公式の視聴ページが開きます（CEDEC のログインが必要）。'
    + '配信そのものは ≡ メニューの公式 YouTube チャンネルからも辿れます'],
];

function openHelp() {
  els.sheetBody.innerHTML = `<div class="detail__top">
    <h2 class="detail__title" id="sheet-title">操作のしかた</h2>
    <p class="detail__meta">あとから ≡ メニューの「操作のしかた」でいつでも開けます</p>
  </div>
  <div class="detail__scroll detail">
    <dl class="help">${HELP_ROWS.map(
      ([what, how]) => `<dt>${esc(what)}</dt><dd>${esc(how)}</dd>`,
    ).join('')}</dl>
  </div>
  <div class="sheet__footer">
    <span class="sheet__spacer"></span>
    <button type="button" class="btn btn--close" data-close aria-label="閉じる">✕</button>
  </div>`;
  els.sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  if (!sheetPushed) {
    history.pushState({ sheet: 'help' }, '');
    sheetPushed = true;
  }
}

function openAbout() {
  const m = state.meta ?? {};
  const stamp = m.sourceLastModified ? new Date(m.sourceLastModified).toLocaleString('ja-JP') : '不明';
  els.sheetBody.innerHTML = `<div class="detail__top">
    <h2 class="detail__title" id="sheet-title">このページについて</h2>
    <p class="detail__meta">セッション ${m.total ?? '-'} 件 · データ ${stamp} 時点</p>
  </div>
  <div class="detail__scroll detail">
    <h3>このページを渡す</h3>
    <div class="qr">
      <img class="qr__img" src="./qr.png" width="180" height="180"
           alt="https://dandymania.github.io/cedec-timetable/ の QR コード">
      <div class="qr__side">
        <p class="qr__url">https://dandymania.github.io/<br>cedec-timetable/</p>
        <button type="button" class="btn btn--sm" id="btn-copy-url">URL をコピー</button>
      </div>
    </div>
    <p>CEDEC 2026 のセッションを探すための<strong>非公式</strong>のビューアです。
    CESA / CEDEC 運営委員会とは関係ありません。</p>
    <h3>データの出どころ</h3>
    <p>セッション情報は <a href="https://cedec.cesa.or.jp/2026/" target="_blank" rel="noopener">CEDEC 2026 公式</a>
    が配布している JSON を取り込んでいます。2 時間ごとの定期実行で取り直していますが、
    GitHub Actions の都合で遅れることがあります。最新は公式サイトを確認してください。</p>
    <p>会場（部屋番号）は公式データに含まれないため、
    <a href="https://kazunori-toybox.com/cedec_schedule/" target="_blank" rel="noopener">CEDEC非公式タイムテーブル</a>
    のデータを利用しています。</p>
    <h3>使い方</h3>
    <p>・検索は話し言葉でOK。略称（サイゲ / バンナム など）も引けます
・カードを長押し、または ☆ でお気に入りに登録できます
・一度開けばオフラインでも表示できます
・ホーム画面に追加するとアプリのように開けます</p>
    <h3>注意</h3>
    <p>最新かつ正確な情報は必ず公式サイトを確認してください。</p>
  </div>
  <div class="sheet__footer">
    <a class="btn btn--sm" href="https://github.com/DandyMania/cedec-timetable"
       target="_blank" rel="noopener">ソース</a>
    <span class="sheet__spacer"></span>
    <button type="button" class="btn btn--close" data-close aria-label="閉じる">✕</button>
  </div>`;
  els.sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  if (!sheetPushed) {
    history.pushState({ sheet: 'about' }, '');
    sheetPushed = true;
  }

  const copy = $('#btn-copy-url');
  copy?.addEventListener('click', async () => {
    const url = 'https://dandymania.github.io/cedec-timetable/';
    try {
      await navigator.clipboard.writeText(url);
      copy.textContent = 'コピーしました';
    } catch {
      copy.textContent = url;
    }
    setTimeout(() => {
      copy.textContent = 'URL をコピー';
    }, 1600);
  });
}

function sessionLink(s) {
  // Archive years load only when ?year= asks for them, so a link to one has to
  // carry the year or it would open the current year and find nothing.
  const year = state.year === CURRENT_YEAR ? '' : `?year=${encodeURIComponent(state.year)}`;
  return `${location.origin}${location.pathname}${year}#s=${encodeURIComponent(s.id)}`;
}

/**
 * Show a QR for one session. At the venue the fastest hand-off is a code the
 * other person points a camera at, so the QR is the screen itself — the OS
 * share sheet and the clipboard sit under it as alternatives.
 */
function openShare(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  const link = sessionLink(s);
  let svg = '';
  try {
    const qr = qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch { /* fall back to the URL alone */ }
  const when = `${s.date ? dayLabel(s.date) : ''} ${s.start ?? ''}${s.end ? `–${s.end}` : ''}`;

  els.sheetBody.innerHTML = `<div class="detail__top">
    <h2 class="detail__title" id="sheet-title">この講演を渡す</h2>
    <p class="detail__meta">${esc(when.trim())}${s.room ? ` · 第${esc(s.room)}会場` : ''}</p>
  </div>
  <div class="detail__scroll detail">
    <p class="share__title">${esc(s.title)}</p>
    ${svg ? `<div class="share__qr">${svg}</div>` : ''}
    <p class="qr__url">${esc(link)}</p>
    <div class="share__acts">
      <button type="button" class="btn btn--sm" data-share-copy>URL をコピー</button>
      ${navigator.share ? '<button type="button" class="btn btn--sm" data-share-os>他のアプリで送る</button>' : ''}
    </div>
    <p class="detail__policy-note">カメラを向けるとこの講演の詳細が開きます。</p>
  </div>
  <div class="sheet__footer">
    <button type="button" class="btn btn--sm" data-share-back="${esc(s.id)}">← 戻る</button>
    <span class="sheet__spacer"></span>
    <button type="button" class="btn btn--close" data-close aria-label="閉じる">✕</button>
  </div>`;
  els.sheet.hidden = false;
  document.body.style.overflow = 'hidden';
  els.sheet.querySelector('.sheet__panel').scrollTop = 0;
  if (!sheetPushed) {
    history.pushState({ sheet: id }, '');
    sheetPushed = true;
  }

  els.sheetBody.querySelector('[data-share-copy]')?.addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(link);
      e.currentTarget.textContent = 'コピーしました';
    } catch {
      e.currentTarget.textContent = 'コピーできなかった';
    }
  });
  els.sheetBody.querySelector('[data-share-os]')?.addEventListener('click', () => {
    navigator.share({ title: s.title, text: `${s.title}\n${when.trim()}`, url: link })
      .catch(() => { /* the user dismissed it */ });
  });
}

function closeSheet(fromPop) {
  els.sheet.hidden = true;
  document.body.style.overflow = '';
  // Only unwind the entry this sheet pushed; never walk further back, or
  // closing would navigate away from the page.
  if (!fromPop && sheetPushed) history.back();
  sheetPushed = false;
}

let lastFavToggle = { id: null, at: -1e9 };

/**
 * Toggle in place. A full re-render would reset the lazy list and yank the
 * scroll position out from under the user's thumb.
 *
 * Repeats on the same card within a moment are ignored: a long press followed
 * by the browser's own click would otherwise set and immediately unset it.
 */
function toggleFav(id) {
  const now = performance.now();
  if (lastFavToggle.id === id && now - lastFavToggle.at < 800) return;
  lastFavToggle = { id, at: now };

  if (state.favs.has(id)) state.favs.delete(id);
  else state.favs.add(id);
  saveFavs();
  const fav = state.favs.has(id);
  const sel = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;

  for (const btn of document.querySelectorAll(`[data-star="${sel}"]`)) {
    btn.setAttribute('aria-pressed', String(fav));
    if (btn.classList.contains('card__star') || btn.classList.contains('btn--star')) {
      btn.textContent = fav ? '★' : '☆';
    }
    btn.classList.toggle('is-fav', fav);
    btn.closest('.card')?.classList.toggle('card--fav', fav);
  }
  const cell = els.list.querySelector(`.gcell[data-id="${sel}"]`);
  cell?.classList.toggle('gcell--fav', fav);
  const cellStar = cell?.querySelector('.gcell__star');
  if (cellStar) cellStar.textContent = fav ? '★' : '☆';
  els.favCount.textContent = String(state.favs.size);

  // The my-plan list is defined by the stars, so it does need rebuilding.
  if (state.day === 'fav') render();
}

// ---------------------------------------------------------------- events

function setViewLabel() {
  els.view.setAttribute('aria-pressed', String(state.view === 'grid'));
  els.viewList.setAttribute('aria-pressed', String(state.view === 'list'));
  els.viewCompact.setAttribute('aria-pressed', String(state.view === 'compact'));
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
    if (!state.query.trim()) state.searchDay = null;
    clearTimeout(timer);
    timer = setTimeout(render, 120);
  });
  // Wrapping the field in a form is what makes iOS show a "search" key; the
  // submit and search events both mean "done", so close the keyboard.
  const doneTyping = () => {
    state.query = els.q.value;
    render();
    els.q.blur();
  };
  els.q.addEventListener('search', doneTyping);
  els.q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doneTyping();
    }
  });
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    doneTyping();
  });
  els.clear.addEventListener('click', () => {
    state.query = '';
    els.q.value = '';
    els.clear.hidden = true;
    els.q.focus();
    render();
  });

  const goToDay = (day) => {
    // Remember where the reader was on the day they are leaving, and restore
    // that spot when they come back to it.
    const boardNow = els.list.querySelector('.grid');
    const prevKey = String(state.day);
    state.scrollMemory[prevKey] = boardNow
      ? { board: boardNow.scrollTop, left: boardNow.scrollLeft }
      : { page: window.scrollY, slot: currentTopSlot() };

    // While searching, a day tap narrows the hits to that day (tap again for
    // every day). Inside my-plan it filters the starred list instead.
    if (state.query.trim()) state.searchDay = state.searchDay === day ? null : day;
    if (state.day === 'fav') state.favDay = state.favDay === day ? null : day;
    else state.day = day;
    scrolledOnce = true;
    render();

    const saved = state.scrollMemory[String(state.day)];
    const board = els.list.querySelector('.grid');
    if (board) {
      board.scrollTop = saved?.board ?? boardNow?.scrollTop ?? 0;
      board.scrollLeft = saved?.left ?? boardNow?.scrollLeft ?? 0;
    } else if (saved?.page != null) {
      const prev = document.documentElement.style.scrollBehavior;
      document.documentElement.style.scrollBehavior = 'auto';
      window.scrollTo({ top: saved.page });
      document.documentElement.style.scrollBehavior = prev;
    } else {
      restoreSlot(currentTopSlot());
    }
  };

  els.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-day]');
    if (btn) goToDay(Number(btn.dataset.day));
  });

  /** Jump straight to a day or to the favourites list, as one strip. */
  function switchView(target) {
    state.day = target;
    if (target === 'fav') {
      state.favDay = null;
      state.query = '';
      els.q.value = '';
      els.clear.hidden = true;
    }
    scrolledOnce = false;
    window.scrollTo({ top: 0 });
    render();
  }

  // Swipe sideways on the list to move between days. The board has its own
  // horizontal scroll, so it is excluded.
  let swipeFrom = null;
  els.list.addEventListener(
    'touchstart',
    (e) => {
      swipeFrom =
        e.touches.length === 1 && !document.body.classList.contains('view-grid')
          ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
          : null;
    },
    { passive: true },
  );
  els.list.addEventListener('touchend', (e) => {
    if (!swipeFrom) return;
    const dx = (e.changedTouches[0]?.clientX ?? swipeFrom.x) - swipeFrom.x;
    const dy = (e.changedTouches[0]?.clientY ?? swipeFrom.y) - swipeFrom.y;
    swipeFrom = null;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
    // The days and the favourites list form one strip: 7/22 … 7/24 … ★
    const strip = [...(state.meta.days ?? []).map((d) => d.day), 'fav'];
    const current = state.query.trim() ? (state.searchDay ?? strip[0]) : state.day;
    const at = strip.indexOf(current);
    const next = strip[at + (dx < 0 ? 1 : -1)];
    if (next == null) return;
    cancelPress();
    if (next === 'fav' || state.day === 'fav') switchView(next);
    else goToDay(next);
  });

  const toggleFilters = () => {
    const open = els.filters.hidden;
    els.filters.hidden = !open;
    els.filtersFloat.setAttribute('aria-pressed', String(open));
    // On a wide screen the panel hangs under the button that opened it.
    if (open && window.matchMedia('(min-width: 1000px)').matches) {
      const btn = els.filtersFloat.getBoundingClientRect();
      const width = els.filters.offsetWidth || 460;
      const left = Math.min(Math.max(8, btn.right - width), window.innerWidth - width - 8);
      els.filters.style.setProperty('--filters-left', `${Math.round(left)}px`);
    } else {
      els.filters.style.removeProperty('--filters-left');
    }
  };
  els.filtersFloat.addEventListener('click', toggleFilters);

  const closeFilters = () => {
    els.filters.hidden = true;
    els.filtersFloat.setAttribute('aria-pressed', 'false');
  };

  // Tapping outside the filter sheet closes it — and does nothing else. Without
  // capturing here, the same tap would also open the card underneath.
  document.addEventListener(
    'click',
    (e) => {
      if (els.filters.hidden || !e.target.isConnected) return;
      if (e.target.closest('#filters') || e.target.closest('#btn-filters-float')) return;
      // The day tabs and the view switcher stay live: close the sheet and let
      // the tap through, since both change what the sheet is filtering.
      if (e.target.closest('.tabs') || e.target.closest('.segmented')) {
        closeFilters();
        return;
      }
      e.stopPropagation();
      e.preventDefault();
      closeFilters();
    },
    true,
  );

  // Only used when the browser has no visualViewport: there the keyboard state
  // is tracked by how much of the viewport it covers (see trackKeyboard).
  if (!window.visualViewport) {
    els.q.addEventListener('focus', () => document.body.classList.add('kb-open'));
    els.q.addEventListener('blur', () => document.body.classList.remove('kb-open'));
  }

  els.filters.addEventListener('change', (e) => {
    if (e.target.id === 'sel-cat') {
      state.cat = e.target.value;
      render();
      return;
    }
    const room = e.target.closest('[data-room]');
    if (!room) return;
    const v = room.dataset.room;
    if (room.checked) state.rooms.add(v);
    else state.rooms.delete(v);
    // Update just the summary line, so the open dropdown keeps its place.
    const summary = els.filters.querySelector('#room-dropdown > summary');
    if (summary) {
      summary.textContent = state.rooms.size
        ? `会場：第${[...state.rooms].sort((a, b) => Number(a) - Number(b)).join('・')}会場`
        : '会場：すべて';
    }
    render();
  });

  els.filters.addEventListener('click', (e) => {
      const flag = e.target.closest('[data-flag]');
    if (flag) {
      const key = flag.dataset.flag;
      const next = { undefined: '+', '+': '-', '-': undefined }[state.flags.get(key)];
      if (next) state.flags.set(key, next);
      else state.flags.delete(key);
      const def = FLAG_FILTERS.find((f) => f.key === key);
      flag.textContent = `${def.label}${
        next === '+' ? '○' : next === '-' ? (def.noMark ?? '✕') : ''
      }`;
      if (next === '-') flag.title = `${def.label}: ${def.noNote ?? ''}`;
      else flag.removeAttribute('title');
      flag.setAttribute('aria-pressed', String(Boolean(next)));
      flag.classList.toggle('is-no', next === '-');
      render();
      return;
    }
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
      state.rooms.clear();
      state.tags.clear();
      state.flags.clear();
      renderFilters();
      render();
    }
  });

  // The side buttons fade in while scrolling and get out of the way after.
  const fabs = document.querySelector('.fabs');
  let fabTimer = null;
  function showFabs() {
    fabs.classList.add('is-visible');
    clearTimeout(fabTimer);
    fabTimer = setTimeout(() => fabs.classList.remove('is-visible'), 900);
  }
  // Only the board's own scrolling shows them directly; the page scroll is
  // handled below, where the direction is known.
  els.list.addEventListener('scroll', showFabs, { capture: true, passive: true });

  // Hide the bottom bar while scrolling down, bring it back on the way up.
  let lastY = window.scrollY;
  window.addEventListener(
    'scroll',
    () => {
      const y = window.scrollY;
      const dy = y - lastY;
      if (Math.abs(dy) < 6) return;
      lastY = y;
      // In grid view the board scrolls on its own, so folding the header there
      // would only hide the room names.
      const canFold =
        els.filters.hidden &&
        !document.body.classList.contains('kb-open') &&
        !document.body.classList.contains('view-grid') &&
        !document.body.classList.contains('bar-top');
      const folding = canFold && dy > 0 && y > 120;
      document.body.classList.toggle('bar-hidden', folding);
      // Set inline: a stylesheet rule here has proved fragile against the
      // wide-screen overrides that also touch this element.
      const bar = document.querySelector('.bottombar');
      if (bar && !document.body.classList.contains('bar-top')) {
        bar.style.transform = folding ? 'translateY(160px)' : '';
        bar.style.opacity = folding ? '0' : '';
      }
      // Reading downwards: get the round buttons out of the way too. They come
      // back the moment the reader scrolls up.
      if (folding) {
        clearTimeout(fabTimer);
        fabs.classList.remove('is-visible');
      } else if (dy < 0) {
        showFabs();
      }
    },
    { passive: true },
  );
  document.addEventListener('touchstart', showFabs, { passive: true });
  fabs.addEventListener('pointerenter', showFabs);
  // Moving the mouse into the lower corner brings the buttons back.
  document.addEventListener(
    'mousemove',
    (e) => {
      if (e.clientX > window.innerWidth - 200 && e.clientY > window.innerHeight - 340) showFabs();
    },
    { passive: true },
  );
  showFabs();

  $('#btn-now').addEventListener('click', jumpToNow);

  $('#btn-top').addEventListener('click', () => {
    const board = els.list.querySelector('.grid');
    if (board) board.scrollTo({ top: 0, behavior: 'smooth' });
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Step through time blocks: slot headings in list view, 30-minute rows in grid view.
  function stepTime(dir) {
    const board = els.list.querySelector('.grid');
    if (board) {
      board.scrollBy({ top: dir * 30 * PX_PER_MIN, behavior: 'smooth' });
      return;
    }
    const top = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 110;
    const slots = [...els.list.querySelectorAll('.slot')];
    if (!slots.length) return;
    const tops = slots.map((s) => s.getBoundingClientRect().top);
    let target = null;
    if (dir > 0) {
      // first heading still below the sticky bar
      target = slots.find((_, i) => tops[i] > top + 6) ?? null;
      if (!target && lazy.drawn < lazy.rows.length) {
        drawMore();
        return stepTime(dir);
      }
    } else {
      // last heading already scrolled past it (the pinned one sits exactly at top)
      for (let i = slots.length - 1; i >= 0; i--) {
        if (tops[i] < top - 6) {
          target = slots[i];
          break;
        }
      }
      if (!target) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
    }
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  $('#btn-prev').addEventListener('click', () => stepTime(-1));
  $('#btn-next').addEventListener('click', () => stepTime(1));

  // Opening the menu locks the page behind it, otherwise a stray swipe scrolls
  // the list under the panel.
  const setMenu = (open) => {
    els.menu.hidden = !open;
    els.btnMenu.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('menu-open', open);
    if (!open && els.sheet.hidden) document.body.style.overflow = '';
  };
  els.btnMenu.addEventListener('click', () => setMenu(els.menu.hidden));

  $('#menu-about').addEventListener('click', () => {
    setMenu(false);
    openAbout();
  });

  $('#menu-help').addEventListener('click', () => {
    setMenu(false);
    openHelp();
  });

  els.fav.addEventListener('click', () => {
    // Toggling favourites keeps the day tabs usable: turning it on shows every
    // starred session, tapping a day then narrows it to that day.
    if (state.day === 'fav') {
      const today = todayIso(state.now);
      switchView((state.meta.days ?? []).find((d) => d.date === today)?.day ?? 1);
    } else {
      switchView('fav');
    }
  });

  document.addEventListener(
    'click',
    (e) => {
      if (els.menu.hidden || !e.target.isConnected) return;
      if (e.target.closest('#menu') || e.target.closest('#btn-menu')) return;
      e.stopPropagation();
      e.preventDefault();
      setMenu(false);
    },
    true,
  );

  els.view.addEventListener('click', () => setView('grid'));
  els.viewList.addEventListener('click', () => setView('list'));
  els.viewCompact.addEventListener('click', () => setView('compact'));

  // Long-press a card to star it without aiming for the small ☆.
  let pressTimer = null;
  let pressScrollY = null;
  let pressFired = false;
  // The suppression window is measured from touchend, so a slow release cannot
  // outlast it and fire a second action on the same gesture.
  let suppressClickUntil = 0;
  const cancelPress = () => {
    clearTimeout(pressTimer);
    pressTimer = null;
    pressScrollY = null;
  };
  let pressAt = null;
  els.list.addEventListener(
    'touchstart',
    (e) => {
      // Works for list cards and for cells on the wall-clock board.
      const card = e.target.closest('[data-id]');
      if (!card || e.target.closest('[data-star]') || e.target.closest('[data-event]')) return;
      const id = card.dataset.id;
      pressAt = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      pressFired = false;
      pressTimer = setTimeout(() => {
        pressFired = true;
        pressTimer = null;
        navigator.vibrate?.(18);
        toggleFav(id);
      }, 500);
    },
    { passive: true },
  );
  // A finger never holds perfectly still: only a real drag cancels the press.
  els.list.addEventListener(
    'touchmove',
    (e) => {
      if (!pressTimer || !pressAt) return;
      const dx = e.touches[0].clientX - pressAt.x;
      const dy = e.touches[0].clientY - pressAt.y;
      if (Math.hypot(dx, dy) > 12) cancelPress();
    },
    { passive: true },
  );
  // Measure the suppression window from the moment the finger lifts: a slow
  // release would otherwise outlast it and let the click through as a second
  // action on the same gesture.
  els.list.addEventListener('touchend', () => {
    if (pressFired) suppressClickUntil = performance.now() + 450;
    cancelPress();
  });
  els.list.addEventListener('touchcancel', cancelPress);
  // A real scroll aborts the press, but the browser also fires scroll events
  // for tiny rubber-band movements, so only give up once the page has actually
  // moved a noticeable amount.
  window.addEventListener(
    'scroll',
    () => {
      if (!pressTimer) return;
      if (pressScrollY == null) {
        pressScrollY = window.scrollY;
        return;
      }
      if (Math.abs(window.scrollY - pressScrollY) > 8) cancelPress();
    },
    { passive: true, capture: true },
  );

  els.list.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('[data-id]');
    if (!card) return;
    e.preventDefault();
    toggleFav(card.dataset.id);
  });

  els.list.addEventListener('click', (e) => {
    if (performance.now() < suppressClickUntil) return;
    // Links inside a card (company names) follow their own href.
    if (e.target.closest('a[href]')) {
      e.stopPropagation();
      return;
    }
    const star = e.target.closest('[data-star]');
    if (star) {
      e.stopPropagation();
      toggleFav(star.dataset.star);
      return;
    }
    const ev = e.target.closest('[data-event]');
    if (ev) {
      window.open(ev.dataset.event, '_blank', 'noopener');
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
    const share = e.target.closest('[data-share]');
    if (share) {
      openShare(share.dataset.share);
      return;
    }
    const back = e.target.closest('[data-share-back]');
    if (back) {
      openSheet(back.dataset.shareBack);
      return;
    }
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
      // Only the header area is a drag handle. Swiping inside the body must
      // scroll the text, never dismiss the sheet.
      const onBody = e.target.closest('.detail__scroll') || e.target.closest('.sheet__footer');
      dragFrom = onBody ? null : e.touches[0].clientY;
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
    if (dy > 130) closeSheet();
  });

  // Flick the body sideways to dismiss: the text only scrolls vertically, so
  // a horizontal swipe is free to mean "close".
  let sheetSwipe = null;
  panel.addEventListener(
    'touchstart',
    (e) => {
      sheetSwipe =
        e.touches.length === 1
          ? { x: e.touches[0].clientX, y: e.touches[0].clientY, top: getScrollTop() }
          : null;
    },
    { passive: true },
  );
  panel.addEventListener('touchend', (e) => {
    if (!sheetSwipe) return;
    const dx = (e.changedTouches[0]?.clientX ?? sheetSwipe.x) - sheetSwipe.x;
    const dy = (e.changedTouches[0]?.clientY ?? sheetSwipe.y) - sheetSwipe.y;
    const startedAtTop = sheetSwipe.top <= 2;
    sheetSwipe = null;
    if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.5) closeSheet();
    else if (startedAtTop && dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.5) closeSheet();
  });

  function getScrollTop() {
    return els.sheet.querySelector('.detail__scroll')?.scrollTop ?? 0;
  }

}

// ---------------------------------------------------------------- boot

/** '' = follow the device, otherwise 'light' | 'dark'. */
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  for (const btn of document.querySelectorAll('[data-theme-set]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.themeSet === theme));
  }
  try {
    localStorage.setItem(STORE_THEME, theme);
  } catch { /* ignore */ }
}

async function boot() {
  loadFavs();
  let savedTheme = '';
  try {
    savedTheme = localStorage.getItem(STORE_THEME) ?? '';
  } catch { /* ignore */ }
  applyTheme(savedTheme);
  for (const btn of document.querySelectorAll('[data-theme-set]')) {
    btn.addEventListener('click', () => applyTheme(btn.dataset.themeSet));
  }
  try {
    const savedView = localStorage.getItem(STORE_VIEW);
    if (savedView === 'grid' || savedView === 'compact' || savedView === 'list') {
      state.view = savedView;
    }
  } catch { /* ignore */ }
  setViewLabel();

  const params = new URLSearchParams(location.search);
  const wanted = params.get('year');

  state.years = await fetch('./data/years.json')
    .then((r) => r.json())
    .catch(() => [{ year: CURRENT_YEAR, archiveOnly: false }]);
  state.year = state.years.some((y) => y.year === wanted) ? wanted : CURRENT_YEAR;

  const [sessions, meta] = await Promise.all([
    fetch(`./data/${state.year}/sessions.json`).then((r) => r.json()),
    fetch(`./data/${state.year}/meta.json`).then((r) => r.json()),
  ]);
  state.sessions = sessions;
  state.meta = meta;
  renderYearMenu();
  document.body.classList.toggle('is-archive', Boolean(meta.archiveOnly));
  if (meta.archiveOnly) {
    document.querySelector('.appbar__title').textContent = `CEDEC ${state.year}`;
    document.title = `CEDEC ${state.year} 講演検索`;
  }
  state.index = buildIndex(sessions);
  buildTagCloud();
  state.events = await fetch('./data/events.json')
    .then((r) => r.json())
    .catch(() => null);

  // Default to today when the conference is running.
  state.now = nowJst();
  const today = todayIso(state.now);
  const match = (meta.days ?? []).find((d) => d.date === today);
  if (match) state.day = match.day;

  const shared = readHash();
  els.q.value = state.query;
  els.clear.hidden = !state.query;

  renderFilters();
  bind();
  render();
  if (shared) openSheet(shared);

  // Sticky time headings need to know how tall the app bar currently is, and
  // the page needs to reserve room for the bottom bar.
  const appbar = document.querySelector('.appbar');
  const bottombar = document.querySelector('.bottombar');
  const syncBars = () => {
    const root = document.documentElement.style;
    const h = appbar.offsetHeight;
    root.setProperty('--appbar-h', `${h}px`);
    // The page reserves space for the expanded bar, so folding does not reflow.
    if (!document.body.classList.contains('bar-hidden')) {
      root.setProperty('--appbar-full-h', `${h}px`);
    }
    root.setProperty('--bottombar-h', `${bottombar.offsetHeight}px`);
  };
  syncBars();
  new ResizeObserver(syncBars).observe(appbar);
  new ResizeObserver(syncBars).observe(bottombar);

  // On a wide screen the search row belongs at the top with the rest of the
  // chrome; on a phone it stays within thumb reach at the bottom.
  const wide = window.matchMedia('(min-width: 1000px)');
  const placeBar = () => {
    const row = appbar.querySelector('.appbar__row');
    if (wide.matches) {
      if (bottombar.parentElement !== row) {
        row.insertBefore(bottombar, row.querySelector('.appbar__actions'));
      }
    } else if (bottombar.parentElement !== document.body) {
      document.body.insertBefore(bottombar, document.querySelector('.fabs'));
    }
    document.body.classList.toggle('bar-top', wide.matches);
    syncBars();
  };
  placeBar();
  wide.addEventListener('change', placeBar);

  // Pull down at the top of the list to refetch the schedule. Installed to the
  // home screen there is no browser chrome, so the built-in gesture is gone.
  const pull = $('#pull');
  const pullText = $('#pull-text');
  const THRESHOLD = 78;
  let pullFrom = null;
  let pulled = 0;
  let refreshing = false;

  const setPull = (y, label) => {
    pull.style.transform = `translateY(${y}px)`;
    pull.classList.toggle('is-on', y > 4);
    if (label) pullText.textContent = label;
  };
  const resetPull = () => {
    pullFrom = null;
    pulled = 0;
    pull.style.transform = '';
    pull.classList.remove('is-on', 'is-busy');
    pullText.textContent = '引っ張って更新';
  };

  async function refreshData() {
    refreshing = true;
    pull.classList.add('is-busy');
    setPull(THRESHOLD, '更新中…');
    try {
      // Also look for a new build: otherwise a fix to the page itself would
      // stay invisible behind the cached copy until the next cold start.
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        await reg?.update();
      } catch { /* offline or unsupported */ }

      const [sessions, meta] = await Promise.all([
        fetch(`./data/${state.year}/sessions.json`, { cache: 'reload' }).then((r) => r.json()),
        fetch(`./data/${state.year}/meta.json`, { cache: 'reload' }).then((r) => r.json()),
      ]);
      state.sessions = sessions;
      state.meta = meta;
      state.index = buildIndex(sessions);
      buildTagCloud();
      renderFilters();
      state.now = nowJst();
      render();
      setPull(THRESHOLD, '最新になったよ');
    } catch {
      setPull(THRESHOLD, '更新できなかった');
    }
    setTimeout(() => {
      refreshing = false;
      resetPull();
    }, 700);
  }

  document.addEventListener(
    'touchstart',
    (e) => {
      const inGrid = document.body.classList.contains('view-grid');
      pullFrom =
        !refreshing && !inGrid && window.scrollY <= 0 && e.touches.length === 1
          ? e.touches[0].clientY
          : null;
    },
    { passive: true },
  );
  document.addEventListener(
    'touchmove',
    (e) => {
      if (pullFrom == null || window.scrollY > 0) return;
      pulled = e.touches[0].clientY - pullFrom;
      if (pulled <= 0) return;
      setPull(Math.min(pulled * 0.45, THRESHOLD + 12), pulled > THRESHOLD ? '離すと更新' : '引っ張って更新');
    },
    { passive: true },
  );
  document.addEventListener('touchend', () => {
    if (pullFrom != null && pulled > THRESHOLD) refreshData();
    else if (!refreshing) resetPull();
    pullFrom = null;
    pulled = 0;
  });

  // Keep the bottom bar above the on-screen keyboard.
  const vv = window.visualViewport;
  if (vv) {
    const trackKeyboard = () => {
      const overlap = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
      document.documentElement.style.setProperty('--kb', `${Math.round(overlap)}px`);
      // Derive the keyboard state from the viewport, not from focus: dismissing
      // the keyboard with the back gesture never fires blur.
      document.body.classList.toggle('kb-open', overlap > 90);
    };
    vv.addEventListener('resize', trackKeyboard);
    vv.addEventListener('scroll', trackKeyboard);
    trackKeyboard();
  }

  const stamp = meta.sourceLastModified ? new Date(meta.sourceLastModified) : null;
  const note = meta.archiveOnly
    ? `${state.year} 年のアーカイブ · ${meta.total} 件（タイトルと登壇者のみ）`
    : `セッション ${meta.total} 件 · データ ${stamp ? stamp.toLocaleString('ja-JP') : '不明'} 時点`;
  els.menuNote.textContent = note;

  // First visit: show the gestures once, so swipe and long press are not
  // hidden features nobody discovers. Someone arriving from a shared link came
  // for that session, so the tutorial waits for their next visit.
  try {
    if (!shared && !localStorage.getItem(STORE_SEEN)) {
      localStorage.setItem(STORE_SEEN, '1');
      setTimeout(openHelp, 400);
    }
  } catch { /* ignore */ }

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
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => {
        // When a new build lands, swap to it right away instead of serving the
        // previous cache until the next visit.
        reg.addEventListener('updatefound', () => {
          const fresh = reg.installing;
          fresh?.addEventListener('statechange', () => {
            if (fresh.state !== 'activated' || !navigator.serviceWorker.controller) return;
            // A device still holding the previous build opens a shared link with
            // code that cannot read it, and the address gets rewritten before
            // the swap lands. Reloading onto the address we arrived at gets the
            // session back. Later updates just reload where the reader is.
            const freshStart = performance.now() < 10000;
            if (freshStart && entryUrl !== location.href) location.replace(entryUrl);
            else location.reload();
          });
        });
      })
      .catch(() => { /* offline support is optional */ });
  }
}

boot().catch((err) => {
  els.list.innerHTML = `<div class="empty">データを読み込めなかった<div class="empty__hint">
    ${esc(err.message)}</div></div>`;
});
