// Build the data the viewer reads.
//
//   node scripts/fetch-data.mjs            # current year only
//   node scripts/fetch-data.mjs --past     # current year + archive years
//   node scripts/fetch-data.mjs --no-room  # skip the room merge
//
// Current year: the official CEDEC feed (has abstracts), with room numbers
// merged in from the community timetable because the official feed omits them.
// Archive years: the community timetable only (title / speakers / room),
// plus CEDiL material links matched by title.
//
// Output: data/<year>/sessions.json, data/<year>/meta.json, data/years.json

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CURRENT_YEAR = '2026';
const PAST_YEARS = ['2025', '2024', '2023', '2022', '2021', '2020'];

const officialUrl = (y) => `https://stat.cedec.cesa.or.jp/download/${y}/cedec_schedule.json`;
const communityUrl = (y) => `https://kazunori-toybox.com/cedec_schedule/web_data/${y}/schedule.json`;
const cedilUrl = (y) => `https://kazunori-toybox.com/cedec_schedule/web_data/${y}/cedil.json`;
const detailUrl = (p) => (p?.startsWith('http') ? p : `https://cedec.cesa.or.jp${p ?? ''}`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');

const useRoom = !process.argv.includes('--no-room');
const withPast = process.argv.includes('--past');

function idFromUrl(url) {
  if (!url) return null;
  const parts = String(url).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/** "エンジニアリング(ENG)" -> { code: 'ENG', label: 'エンジニアリング' } */
function splitCode(value) {
  if (!value || typeof value !== 'string') return { code: '', label: '' };
  const m = value.match(/^(.*?)[(（]([A-Za-z0-9&+\-]+)[)）]\s*$/);
  if (m) return { code: m[2].trim(), label: m[1].trim() };
  return { code: '', label: value.trim() };
}

/** "1:中辛(この分野の初心者へ)" -> { level, label, note } */
function parseDifficulty(value) {
  if (!value || typeof value !== 'string') return null;
  const m = value.match(/^\s*(\d+)\s*[:：]\s*([^(（]*)[(（]?([^)）]*)/);
  if (!m) return { level: null, label: value.trim(), note: '' };
  return { level: Number(m[1]), label: m[2].trim(), note: (m[3] || '').trim() };
}

/** "2026/07/22 11:10:00" -> { date, time, minutes } */
function parseStamp(value) {
  if (!value || typeof value !== 'string') return null;
  const m = value.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}`, minutes: Number(h) * 60 + Number(mi) };
}

/** "18:00" -> 1080 */
function toMinutes(hhmm) {
  const m = String(hhmm ?? '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** first_date "0722" + day "2" -> "2026-07-23" */
function dateFromFirst(year, firstDate, day) {
  if (!firstDate || !day) return null;
  const m = String(firstDate).match(/^(\d{2})(\d{2})$/);
  if (!m) return null;
  const base = new Date(Date.UTC(Number(year), Number(m[1]) - 1, Number(m[2])));
  base.setUTCDate(base.getUTCDate() + (Number(day) - 1));
  return base.toISOString().slice(0, 10);
}

function splitList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value !== 'string') return [];
  return value
    .split(/[,、\/\n\r|｜]+/)
    .map((v) => v.trim())
    .filter((v) => v && v !== '該当なし' && v !== 'カテゴリなし');
}

function clean(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n').trim();
}

/** Titles differ in spacing/width between feeds, so normalize before matching. */
function titleKey(title) {
  return String(title ?? '')
    .normalize('NFKC')
    .replace(/[\s　]/g, '')
    .toLowerCase();
}

async function fetchJson(url, label) {
  const res = await fetch(url, { headers: { 'user-agent': 'cedec-timetable-viewer' } });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  return { json: await res.json(), lastModified: res.headers.get('last-modified') || null };
}

async function fetchCedil(year) {
  try {
    const { json } = await fetchJson(cedilUrl(year), 'cedil');
    const map = new Map();
    for (const item of json?.list ?? []) {
      if (item?.title && item?.url) map.set(titleKey(item.title), item.url);
    }
    return map;
  } catch {
    return new Map();
  }
}

// Reuse the CEDiL links already on disk when the source gave us nothing.
//
// Same reasoning as the room fallback in buildCurrent: a transient outage at
// the source must not wipe data we already have. Without this, an empty map
// turned every `cedilUrl` into null while the `cedil` flag kept saying the
// material exists, leaving the file self-contradictory.
//
// Measured 2026-08-01: the scheduled run 4f1d2f1 dropped all 87 links this way
// (cedil flag stayed at 195). Re-running once the source was reachable
// restored all 87, so the loss was purely a fetch failure being swallowed.
async function reusePreviousCedil(year, map) {
  if (map.size) return map;
  try {
    const prev = JSON.parse(
      await readFile(path.join(DATA_DIR, year, 'sessions.json'), 'utf8'),
    );
    for (const s of prev) {
      if (s.title && s.cedilUrl) map.set(titleKey(s.title), s.cedilUrl);
    }
    console.warn(`  reused ${map.size} CEDiL links from the previous build`);
  } catch {
    console.warn('  no previous CEDiL links to fall back on');
  }
  return map;
}

/** Stretches of 20+ minutes where no room has a session: breaks. */
function findBreaks(sessions) {
  const byDay = new Map();
  for (const s of sessions) {
    if (s.day == null || s.startMin == null || s.endMin == null) continue;
    if (!byDay.has(s.day)) byDay.set(s.day, []);
    byDay.get(s.day).push([s.startMin, s.endMin]);
  }
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const out = [];
  for (const [day, spans] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
      else merged.push([...span]);
    }
    for (let i = 1; i < merged.length; i++) {
      const from = merged[i - 1][1];
      const to = merged[i][0];
      if (to - from < 20) continue;
      // A long gap straddling noon is the lunch break.
      const lunch = to - from >= 30 && from < 14 * 60 && to > 11 * 60 + 30;
      out.push({
        day,
        from,
        to,
        start: fmt(from),
        end: fmt(to),
        label: lunch ? '昼休み' : '休憩',
      });
    }
  }
  return out;
}

function summarize(year, sessions, extra) {
  const dates = [...new Set(sessions.map((s) => s.date).filter(Boolean))].sort();
  const categories = [];
  const seen = new Set();
  for (const s of sessions) {
    if (!s.category || seen.has(s.category)) continue;
    seen.add(s.category);
    categories.push({ code: s.category, label: s.categoryLabel || s.category });
  }
  return {
    year,
    total: sessions.length,
    days: dates.map((date, i) => ({
      day: i + 1,
      date,
      count: sessions.filter((s) => s.date === date).length,
    })),
    undated: sessions.filter((s) => s.day == null).length,
    categories,
    rooms: [...new Set(sessions.map((s) => s.room).filter(Boolean))].sort((a, b) => Number(a) - Number(b)),
    breaks: findBreaks(sessions),
    ...extra,
  };
}

function sortSessions(sessions) {
  sessions.sort((a, b) => {
    if (a.day == null && b.day == null) return a.title.localeCompare(b.title, 'ja');
    if (a.day == null) return 1;
    if (b.day == null) return -1;
    if (a.day !== b.day) return a.day - b.day;
    if (a.startMin !== b.startMin) return (a.startMin ?? 0) - (b.startMin ?? 0);
    return Number(a.room ?? 0) - Number(b.room ?? 0);
  });
  return sessions;
}

// ---------------------------------------------------------------- current year

async function buildCurrent(year) {
  console.log(`[${year}] official feed`);
  const official = await fetchJson(officialUrl(year), 'official');
  const raw = official.json;
  if (!Array.isArray(raw)) throw new Error('official feed is not an array');
  console.log(`  ${raw.length} entries`);

  const roomById = new Map();
  if (useRoom) {
    try {
      const community = await fetchJson(communityUrl(year), 'community');
      for (const s of community.json?.sessions ?? []) {
        if (s.id && s.room) roomById.set(s.id, String(s.room));
      }
      console.log(`  ${roomById.size} rooms merged`);
    } catch (err) {
      console.warn(`  rooms unavailable (${err.message})`);
    }
    if (!roomById.size) {
      // Fall back to the rooms already on disk: losing them empties the
      // wall-clock grid, which is worse than serving slightly stale rooms.
      try {
        const prev = JSON.parse(await readFile(path.join(DATA_DIR, year, 'sessions.json'), 'utf8'));
        for (const s of prev) if (s.id && s.room) roomById.set(s.id, String(s.room));
        console.warn(`  reused ${roomById.size} rooms from the previous build`);
      } catch {
        console.warn('  no previous rooms to fall back on');
      }
    }
  }

  const cedilByTitle = await reusePreviousCedil(year, await fetchCedil(year));

  const dates = [...new Set(raw.map((s) => parseStamp(s.start)?.date).filter(Boolean))].sort();
  const dayByDate = new Map(dates.map((d, i) => [d, i + 1]));

  const sessions = raw.map((s, index) => {
    const id = idFromUrl(s.URL) || `noid-${index}`;
    const start = parseStamp(s.start);
    const end = parseStamp(s.end);
    const category = splitCode(s.category);
    const format = splitCode(s.format);
    const notes = (Array.isArray(s.note) ? s.note : splitList(s.note)).map(clean).filter(Boolean);

    return {
      id,
      day: start ? dayByDate.get(start.date) ?? null : null,
      date: start?.date ?? null,
      start: start?.time ?? null,
      end: end?.time ?? null,
      startMin: start?.minutes ?? null,
      endMin: end?.minutes ?? null,
      room: roomById.get(id) ?? null,
      title: clean(s.title),
      category: category.code || category.label,
      categoryLabel: category.label,
      subCategory: splitList(s.sub_category),
      format: clean(s.format),
      formatLabel: format.label || clean(s.format),
      platform: splitList(s.platform),
      keywords: splitList(s.keywordtag),
      difficulty: parseDifficulty(s.difficulty),
      description: clean(s.description),
      takeaway: clean(s.takeaway),
      expectedSkill: clean(s.expected_skill),
      speakers: (Array.isArray(s.speakers) ? s.speakers : []).map((sp) => ({
        name: clean(sp.name),
        company: clean(sp.company),
        profile: clean(sp.profile),
        message: clean(sp.message),
      })),
      photoOk: s.photo_ok === true || s.photo_ok === 'true',
      snsOk: s.sns_ok === true || s.sns_ok === 'true',
      cedil: s.CEDiL === 1 || s.CEDiL === true,
      cedilUrl: cedilByTitle.get(titleKey(s.title)) ?? null,
      notes,
      // Three states, not two: some sessions say "配信 OK", some say
      // "配信 NG", and many say nothing about streaming at all.
      streamState: notes.some((n) => /配信\s*OK/i.test(n))
        ? 'ok'
        : notes.some((n) => /配信\s*NG/i.test(n))
          ? 'ng'
          : null,
      liveStream: notes.some((n) => /配信\s*OK/.test(n)),
      archive: notes.some((n) => n.includes('アーカイブ可')),
      askSpeaker: notes.some((n) => n.includes('ASK the Speaker')),
      interpreted: notes.some((n) => n.includes('通訳')),
      url: clean(s.URL),
    };
  });

  sortSessions(sessions);
  return {
    sessions,
    meta: summarize(year, sessions, {
      generatedAt: new Date().toISOString(),
      sourceUrl: officialUrl(year),
      sourceLastModified: official.lastModified,
      roomSource: roomById.size ? communityUrl(year) : null,
      archiveOnly: false,
    }),
  };
}

// ---------------------------------------------------------------- past years

async function buildPast(year) {
  console.log(`[${year}] archive`);
  const community = await fetchJson(communityUrl(year), 'community');
  const body = community.json ?? {};
  const raw = body.sessions ?? [];
  const cedilByTitle = await reusePreviousCedil(year, await fetchCedil(year));

  const sessions = raw.map((s, index) => {
    const startMin = toMinutes(s.start);
    const endMin = toMinutes(s.end);
    const category = splitCode(s.category);
    return {
      id: s.id || `noid-${index}`,
      day: s.day ? Number(s.day) : null,
      date: dateFromFirst(year, body.first_date, s.day),
      start: s.start ?? null,
      end: s.end ?? null,
      startMin,
      endMin,
      room: s.room != null ? String(s.room) : null,
      title: clean(s.title),
      category: category.code || clean(s.category),
      categoryLabel: category.label || clean(s.category),
      subCategory: splitList(s.sub_category),
      format: '',
      formatLabel: '',
      platform: [],
      keywords: [],
      difficulty: null,
      description: '',
      takeaway: '',
      expectedSkill: '',
      speakers: (Array.isArray(s.speakers) ? s.speakers : []).map((sp) => ({
        name: clean(sp.name),
        company: clean(sp.company),
        profile: '',
        message: '',
      })),
      photoOk: false,
      snsOk: false,
      cedil: false,
      cedilUrl: cedilByTitle.get(titleKey(s.title)) ?? null,
      notes: [],
      streamState: s.youtube ? 'ok' : null,
      liveStream: Boolean(s.youtube),
      archive: false,
      askSpeaker: false,
      interpreted: false,
      url: detailUrl(s.detail_url),
    };
  });

  sortSessions(sessions);
  const withMaterial = sessions.filter((s) => s.cedilUrl).length;
  console.log(`  ${sessions.length} sessions, ${withMaterial} with CEDiL links`);

  return {
    sessions,
    meta: summarize(year, sessions, {
      generatedAt: new Date().toISOString(),
      sourceUrl: communityUrl(year),
      sourceLastModified: null,
      roomSource: communityUrl(year),
      archiveOnly: true,
    }),
  };
}

// ---------------------------------------------------------------- main

// Keep the previous `generatedAt` when nothing else changed.
//
// `generatedAt` is the time of the fetch, so a fresh value on every run made
// meta.json differ even when the source was untouched. The deploy workflow
// commits whenever `git status --porcelain data` is non-empty, so that guard
// never held: every scheduled run produced a commit and a redeploy. Measured
// 2026-08-01 — 36 consecutive bot commits whose only change was this field,
// while sessions.json and sourceLastModified stayed put.
//
// Nothing reads `generatedAt` (app.js shows `sourceLastModified`), so it is
// kept for provenance only and must not churn. Comparing with the field
// blanked on both sides is what makes "unchanged" mean unchanged.
async function write(year, built) {
  const dir = path.join(DATA_DIR, year);
  await mkdir(dir, { recursive: true });

  const sessionsPath = path.join(dir, 'sessions.json');
  const metaPath = path.join(dir, 'meta.json');
  const sessionsText = JSON.stringify(built.sessions);

  try {
    const previous = JSON.parse(await readFile(metaPath, 'utf8'));
    const previousSessions = await readFile(sessionsPath, 'utf8');
    // Spreading keeps each key in its original position, so this compares
    // structure and values while ignoring only the timestamp.
    const same =
      previousSessions === sessionsText &&
      JSON.stringify({ ...previous, generatedAt: null }) ===
        JSON.stringify({ ...built.meta, generatedAt: null });
    if (same && previous.generatedAt) built.meta.generatedAt = previous.generatedAt;
  } catch {
    // No previous output (or it is unreadable) — write a fresh timestamp.
  }

  await writeFile(sessionsPath, sessionsText, 'utf8');
  await writeFile(metaPath, JSON.stringify(built.meta, null, 2), 'utf8');
}

async function main() {
  const years = [];

  const current = await buildCurrent(CURRENT_YEAR);
  await write(CURRENT_YEAR, current);
  years.push({ year: CURRENT_YEAR, total: current.meta.total, archiveOnly: false });
  console.log(`  wrote ${current.meta.total} sessions`);

  if (withPast) {
    for (const year of PAST_YEARS) {
      try {
        const built = await buildPast(year);
        await write(year, built);
        years.push({ year, total: built.meta.total, archiveOnly: true });
      } catch (err) {
        console.warn(`[${year}] skipped (${err.message})`);
      }
    }
  }

  // Keep archive years listed even on a current-year-only refresh: the
  // scheduled job runs without --past and must not drop them.
  const yearsPath = path.join(DATA_DIR, 'years.json');
  let merged = years;
  if (!withPast) {
    try {
      const existing = JSON.parse(await readFile(yearsPath, 'utf8'));
      const byYear = new Map(existing.map((y) => [y.year, y]));
      for (const y of years) byYear.set(y.year, y);
      merged = [...byYear.values()].sort((a, b) => Number(b.year) - Number(a.year));
    } catch {
      /* no previous list: fall back to what we just built */
    }
  }

  await writeFile(yearsPath, JSON.stringify(merged, null, 2), 'utf8');
  console.log(`years: ${merged.map((y) => y.year).join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
