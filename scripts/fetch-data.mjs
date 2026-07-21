// Fetch the official CEDEC schedule JSON and normalize it for the viewer.
// Also merges room numbers from the community timetable (rooms are missing from the official feed).
// Usage: node scripts/fetch-data.mjs [--no-room]
//
// Output: data/sessions.json, data/meta.json

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const YEAR = '2026';
const OFFICIAL_URL = `https://stat.cedec.cesa.or.jp/download/${YEAR}/cedec_schedule.json`;
const ROOM_URL = `https://kazunori-toybox.com/cedec_schedule/web_data/${YEAR}/schedule.json`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');

const useRoom = !process.argv.includes('--no-room');

/** Pull the trailing id segment out of a detail URL. */
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

/** "1:中辛(この分野の初心者へ)" -> { level: 1, label: '中辛', note: 'この分野の初心者へ' } */
function parseDifficulty(value) {
  if (!value || typeof value !== 'string') return null;
  const m = value.match(/^\s*(\d+)\s*[:：]\s*([^(（]*)[(（]?([^)）]*)/);
  if (!m) return { level: null, label: value.trim(), note: '' };
  return { level: Number(m[1]), label: m[2].trim(), note: (m[3] || '').trim() };
}

/** "2026/07/22 11:10:00" -> { date: '2026-07-22', time: '11:10', minutes: 670 } */
function parseStamp(value) {
  if (!value || typeof value !== 'string') return null;
  const m = value.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return {
    date: `${y}-${mo}-${d}`,
    time: `${h}:${mi}`,
    minutes: Number(h) * 60 + Number(mi),
  };
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

async function fetchJson(url, label) {
  const res = await fetch(url, { headers: { 'user-agent': 'cedec-timetable-viewer' } });
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
  const lastModified = res.headers.get('last-modified') || null;
  return { json: await res.json(), lastModified };
}

async function main() {
  console.log(`fetching official feed: ${OFFICIAL_URL}`);
  const official = await fetchJson(OFFICIAL_URL, 'official');
  const raw = official.json;
  if (!Array.isArray(raw)) throw new Error('official feed is not an array');
  console.log(`  ${raw.length} entries`);

  const roomById = new Map();
  if (useRoom) {
    try {
      console.log(`fetching room data: ${ROOM_URL}`);
      const community = await fetchJson(ROOM_URL, 'community');
      for (const s of community.json?.sessions ?? []) {
        if (s.id && s.room) roomById.set(s.id, String(s.room));
      }
      console.log(`  ${roomById.size} room entries`);
    } catch (err) {
      console.warn(`  room data unavailable (${err.message}) - continuing without rooms`);
    }
  }

  // Establish day numbers from the sorted set of dates that actually occur.
  const dates = [
    ...new Set(
      raw
        .map((s) => parseStamp(s.start)?.date)
        .filter(Boolean),
    ),
  ].sort();
  const dayByDate = new Map(dates.map((d, i) => [d, i + 1]));

  const sessions = raw.map((s, index) => {
    const id = idFromUrl(s.URL) || `noid-${index}`;
    const start = parseStamp(s.start);
    const end = parseStamp(s.end);
    const category = splitCode(s.category);
    const format = splitCode(s.format);

    const notes = (Array.isArray(s.note) ? s.note : splitList(s.note)).map(clean).filter(Boolean);

    const speakers = (Array.isArray(s.speakers) ? s.speakers : []).map((sp) => ({
      name: clean(sp.name),
      company: clean(sp.company),
      profile: clean(sp.profile),
      message: clean(sp.message),
    }));

    return {
      id,
      day: start ? dayByDate.get(start.date) ?? null : null,
      date: start?.date ?? null,
      start: start?.time ?? null,
      end: end?.time ?? null,
      startMin: start?.minutes ?? null,
      endMin: end?.minutes ?? null,
      lengthMin: start && end ? end.minutes - start.minutes : null,
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
      speakers,
      photoOk: s.photo_ok === true || s.photo_ok === 'true',
      snsOk: s.sns_ok === true || s.sns_ok === 'true',
      cedil: s.CEDiL === 1 || s.CEDiL === true,
      // note is a list of flags: streaming, archive, interpretation, Ask the Speaker...
      notes,
      liveStream: notes.some((n) => /配信\s*OK/.test(n)),
      archive: notes.some((n) => n.includes('アーカイブ可')),
      askSpeaker: notes.some((n) => n.includes('ASK the Speaker')),
      interpreted: notes.some((n) => n.includes('通訳')),
      url: clean(s.URL),
    };
  });

  // Scheduled sessions first (by day/time), then undated ones.
  sessions.sort((a, b) => {
    if (a.day == null && b.day == null) return a.title.localeCompare(b.title, 'ja');
    if (a.day == null) return 1;
    if (b.day == null) return -1;
    if (a.day !== b.day) return a.day - b.day;
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return Number(a.room ?? 0) - Number(b.room ?? 0);
  });

  const countBy = (fn) => {
    const map = new Map();
    for (const s of sessions) {
      const key = fn(s);
      if (key == null || key === '') continue;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
  };

  const categories = [];
  const seenCategory = new Set();
  for (const s of sessions) {
    if (!s.category || seenCategory.has(s.category)) continue;
    seenCategory.add(s.category);
    categories.push({ code: s.category, label: s.categoryLabel || s.category });
  }

  const meta = {
    year: YEAR,
    generatedAt: new Date().toISOString(),
    sourceUrl: OFFICIAL_URL,
    sourceLastModified: official.lastModified,
    roomSource: roomById.size ? ROOM_URL : null,
    total: sessions.length,
    days: dates.map((date, i) => ({
      day: i + 1,
      date,
      count: sessions.filter((s) => s.date === date).length,
    })),
    undated: sessions.filter((s) => s.day == null).length,
    categories,
    formats: countBy((s) => s.formatLabel),
    difficulties: countBy((s) => s.difficulty?.label),
    rooms: [...new Set(sessions.map((s) => s.room).filter(Boolean))].sort(
      (a, b) => Number(a) - Number(b),
    ),
  };

  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(path.join(DATA_DIR, 'sessions.json'), JSON.stringify(sessions), 'utf8');
  await writeFile(path.join(DATA_DIR, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  console.log(`wrote ${sessions.length} sessions`);
  console.log(`  days: ${meta.days.map((d) => `${d.date}=${d.count}`).join(' ')}`);
  console.log(`  undated: ${meta.undated}`);
  console.log(`  rooms: ${meta.rooms.length}`);
  console.log(`  keywords present: ${sessions.filter((s) => s.keywords.length).length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
