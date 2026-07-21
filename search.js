// Search engine for the CEDEC timetable viewer.
// Everything runs client-side and offline: the corpus is only ~1MB of text over
// ~220 sessions, so a straight scan with weighted field matching is fast enough
// and avoids shipping an index or a model.

/** Normalize for matching: NFKC, lower case, hiragana -> katakana, strip noise. */
export function normalize(text) {
  if (!text) return '';
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[ー‐-―-_~\/\\|]/g, '')
    .replace(/[「」『』（）()\[\]【】《》〈〉"'`,.、。!！?？:：;；・*+#@]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Phrases that carry no signal in a spoken-style query. These run *after*
// normalize(), which folds hiragana into katakana, so they are written in
// katakana on purpose.
const FILLER = [
  /ニツイテ(ノ|ハ|モ)?/g,
  /ニ関(スル|シテ)/g,
  /ニカン(スル|シテ)/g,
  /ミタイナ(ノハ|ノ)?/g,
  /ノヨウナ/g,
  /ドンナ/g,
  /ドウイウ/g,
  /(ガ|ヲ|ハ)?(聞|キ)キタイ/g,
  /(ガ|ヲ|ハ)?知リタイ/g,
  /(ガ|ヲ|ハ)?探シテ(イル|ル)?/g,
  /(ヲ|ガ)?教エテ(ホシイ|クレ)?/g,
  /(シ|ヤリ)タイ/g,
  /デスカ?/g,
  /マスカ?/g,
  /クダサイ/g,
  /セッション/g,
  /講演/g,
  /トカ/g,
  /ナド/g,
  /ヨウナ/g,
  /(ノ)?話(ヲ|ガ|ハ)?/g,
];

// Trailing grammatical particles, in katakana for the same reason. A query
// chunk like "サイゲノ" also gets searched as "サイゲ".
const TAIL_PARTICLE = /^(.{2,}?)(ニツイテ|ニカンスル|カラ|マデ|ヨリ|ノ|ニ|ヲ|ハ|ガ|デ|ト|モ|ヘ)$/;

// Query word -> extra words to also look for. Bidirectional at build time.
const SYNONYM_SEED = [
  ['ai', '人工知能', '機械学習', 'ml', 'llm', '生成ai', 'ディープラーニング', '深層学習', 'エージェント'],
  ['llm', '大規模言語モデル', '生成ai', 'gpt', 'チャットボット'],
  ['最適化', 'パフォーマンス', '高速化', '軽量化', 'チューニング', '負荷', 'ボトルネック', 'fps'],
  ['描画', 'レンダリング', 'グラフィックス', 'シェーダ', 'gpu', 'ライティング', '表現'],
  ['演出', 'エフェクト', 'vfx', 'アニメーション', 'モーション'],
  ['サウンド', '音', 'オーディオ', '音響', 'bgm', '効果音', 'ボイス', '音楽'],
  ['ネットワーク', '通信', 'オンライン', 'マルチプレイ', 'サーバ', 'サーバー', '同期'],
  ['運用', '運営', 'ライブサービス', '継続', 'kpi', '分析', 'データ分析'],
  ['自動化', 'ci', 'cd', 'ビルド', 'パイプライン', 'ワークフロー', '効率化', '省力化', 'ツール'],
  ['テスト', '品質', 'qa', 'デバッグ', '不具合', 'バグ', '検証'],
  ['チーム', '組織', 'マネジメント', '育成', '採用', '働き方', 'コミュニケーション', '文化'],
  ['進行', 'スケジュール', '見積', '計画', 'プロジェクト管理', 'アジャイル', 'スクラム'],
  ['ux', 'ui', 'ユーザー体験', 'インターフェース', '操作性', 'アクセシビリティ'],
  ['レベルデザイン', 'ゲームデザイン', 'バランス', '設計', '面白さ'],
  ['シナリオ', 'ストーリー', '物語', '脚本', 'ナラティブ', 'テキスト'],
  ['キャラクター', 'モデリング', 'リギング', 'スキニング', 'アバター'],
  ['背景', '地形', '環境', 'ワールド', 'ステージ', 'プロシージャル'],
  ['物理', 'シミュレーション', '衝突', 'コリジョン'],
  ['メモリ', 'ロード', '容量', 'アセット管理', 'ストリーミング'],
  ['セキュリティ', 'チート', '不正', '脆弱性', '対策'],
  ['法務', '契約', '権利', '著作権', 'ライセンス', 'コンプライアンス', 'リスク'],
  ['マーケティング', '宣伝', 'プロモーション', '集客', '販売', 'ストア'],
  ['海外', 'グローバル', 'ローカライズ', '翻訳', '多言語', '文化差'],
  ['vr', 'xr', 'ar', 'メタバース', '没入'],
  ['モバイル', 'スマホ', 'ios', 'android', 'アプリ'],
  ['コンソール', 'ps5', 'switch', 'xbox', '家庭用'],
  ['pc', 'steam', 'インディー', '個人開発', '同人'],
  ['unity', 'ユニティ'],
  ['unreal', 'ue5', 'アンリアル', 'アンリアルエンジン'],
  ['内製', '自社エンジン', 'エンジン開発', '基盤'],
  ['新人', '初心者', '入門', '基礎', 'はじめて', '若手'],
  ['事例', '実例', '実践', '導入', '取り組み', '挑戦'],
  ['失敗', '反省', '振り返り', '学び', '教訓', 'ポストモーテム'],
];

// Nicknames and English/Japanese spellings for companies that appear in the
// speaker list. Typing "サイゲ" should find "株式会社Cygames".
const COMPANY_SEED = [
  ['サイゲ', 'サイゲームス', 'cygames'],
  ['バンナム', 'バンダイナムコ', 'bandai namco', 'バンダイナムコスタジオ', 'バンダイナムコエクスペリエンス'],
  ['スクエニ', 'スクウェアエニックス', 'square enix'],
  ['カプコン', 'capcom'],
  ['任天堂', 'ニンテンドー', 'nintendo'],
  ['セガ', 'sega'],
  ['コナミ', 'konami', 'コナミデジタルエンタテインメント'],
  ['デナ', 'dena', 'ディーエヌエー'],
  ['ミクシィ', 'mixi'],
  ['グリー', 'gree'],
  ['サイバーエージェント', 'サイバー', 'cyberagent'],
  ['ソニー', 'sie', 'sony', 'プレイステーション', 'プレステ', 'playstation', 'ソニーインタラクティブエンタテインメント'],
  ['エピック', 'epic', 'epic games'],
  ['ユニティ', 'unity'],
  ['アカツキ', 'アカツキゲームス', 'akatsuki'],
  ['プラチナ', 'プラチナゲームズ', 'platinumgames'],
  ['ポリフォニー', 'ポリフォニーデジタル', 'polyphony'],
  ['ゲーフリ', 'ゲームフリーク', 'game freak'],
  ['クラブ', 'klab'],
  ['エヌビディア', 'nvidia'],
  ['アマゾン', 'aws', 'amazon'],
  ['ユービーアイ', 'ubisoft'],
  ['ネットイース', 'netease'],
  ['スパーク', 'spark'],
  ['シリコンスタジオ', 'silicon studio'],
  ['リアリティ', 'reality'],
  ['ミライセンス', 'miraisens'],
];
SYNONYM_SEED.push(...COMPANY_SEED);

const SYNONYMS = new Map();
for (const group of SYNONYM_SEED) {
  for (const word of group) {
    const key = normalize(word);
    const set = SYNONYMS.get(key) ?? new Set();
    for (const other of group) {
      const o = normalize(other);
      if (o && o !== key) set.add(o);
    }
    SYNONYMS.set(key, set);
  }
}

const KANA = /[ァ-ヺー]/;
const KANJI = /[一-鿿々]/;
const LATIN = /[a-z0-9]/;

function charClass(c) {
  if (LATIN.test(c)) return 'latin';
  if (KANA.test(c)) return 'kana';
  if (KANJI.test(c)) return 'kanji';
  if (/[ぁ-ゖ]/.test(c)) return 'hira';
  return 'other';
}

/** Split a normalized string into word-ish chunks by character class. */
function chunk(text) {
  const out = [];
  let cur = '';
  let curClass = null;
  for (const c of text) {
    const cls = charClass(c);
    if (cls === 'other') {
      if (cur) out.push({ text: cur, cls: curClass });
      cur = '';
      curClass = null;
      continue;
    }
    if (cls !== curClass) {
      if (cur) out.push({ text: cur, cls: curClass });
      cur = c;
      curClass = cls;
    } else {
      cur += c;
    }
  }
  if (cur) out.push({ text: cur, cls: curClass });
  return out;
}

/** Break a long chunk into overlapping bigrams for partial matching. */
function bigrams(text) {
  const out = [];
  for (let i = 0; i < text.length - 1; i++) out.push(text.slice(i, i + 2));
  return out;
}

/**
 * Turn a free-form query into terms.
 * Each term: { text, weight, kind } where kind is 'core' | 'part' | 'syn'.
 */
export function parseQuery(query) {
  let text = normalize(query);
  for (const re of FILLER) text = text.replace(re, ' ');
  text = text.replace(/\s+/g, ' ').trim();

  const terms = [];
  const seen = new Set();
  const push = (t, weight, kind) => {
    if (!t || t.length < (kind === 'part' ? 2 : 1)) return;
    const key = `${kind}:${t}`;
    if (seen.has(key)) return;
    seen.add(key);
    terms.push({ text: t, weight, kind });
  };

  const groups = [];
  for (const c of chunk(text)) {
    if (c.cls === 'hira' && c.text.length < 3) continue; // particles / inflection
    if (c.cls === 'latin' && c.text.length < 2 && !/\d/.test(c.text)) continue;
    if (c.cls === 'kana' && c.text.length < 2) continue; // stray particle

    // "サイゲノ" -> also try "サイゲ". Keeping both is safe: a wrong split
    // simply matches nothing.
    const forms = [c.text];
    const stripped = c.text.match(TAIL_PARTICLE);
    if (stripped && c.cls !== 'latin') forms.push(stripped[1]);

    for (const form of forms) {
      groups.push(form);
      push(form, 1, 'core');
      if (form.length >= 3) for (const g of bigrams(form)) push(g, 0.25, 'part');
      for (const syn of SYNONYMS.get(form) ?? []) push(syn, 0.55, 'syn');
    }
  }

  // Whole normalized query as a phrase, when it is a single short expression.
  if (text && text.length <= 24 && groups.length > 1) push(text, 1.4, 'core');

  return { terms, groups, cleaned: text };
}

// Field weights: a hit in the title matters far more than one deep in a bio.
const FIELDS = [
  ['title', 3.4],
  ['keywords', 2.2],
  ['category', 1.2],
  ['speakers', 1.6],
  ['takeaway', 1.5],
  ['description', 1.3],
  ['expectedSkill', 0.9],
  ['profiles', 0.5],
];

/** Precompute the normalized haystacks once per session record. */
export function buildIndex(sessions) {
  return sessions.map((s) => ({
    id: s.id,
    title: normalize(s.title),
    keywords: normalize([...(s.keywords ?? []), ...(s.subCategory ?? []), ...(s.platform ?? [])].join(' ')),
    category: normalize(`${s.category} ${s.categoryLabel} ${s.formatLabel}`),
    speakers: normalize((s.speakers ?? []).map((x) => `${x.name} ${x.company}`).join(' ')),
    takeaway: normalize(s.takeaway),
    description: normalize(s.description),
    expectedSkill: normalize(s.expectedSkill),
    profiles: normalize((s.speakers ?? []).map((x) => `${x.profile} ${x.message}`).join(' ')),
  }));
}

function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  let count = 0;
  let from = 0;
  while (count < 4) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    count++;
    from = at + needle.length;
  }
  return count;
}

/**
 * Score sessions against a query.
 * Returns [{ index, score, hits:Set<termText> }] sorted by score, best first.
 */
export function search(query, index) {
  const { terms, groups } = parseQuery(query);
  if (!terms.length) return null;

  const coreTerms = terms.filter((t) => t.kind === 'core' && t.text.length >= 2);
  const results = [];

  for (let i = 0; i < index.length; i++) {
    const doc = index[i];
    let score = 0;
    const hits = new Set();
    const coveredGroups = new Set();

    for (const term of terms) {
      let best = 0;
      for (const [field, fieldWeight] of FIELDS) {
        const n = countOccurrences(doc[field], term.text);
        if (!n) continue;
        const value = fieldWeight * term.weight * (1 + Math.log2(n));
        if (value > best) best = value;
        if (term.kind !== 'part') hits.add(term.text);
      }
      if (best > 0) {
        score += best;
        if (term.kind === 'core') coveredGroups.add(term.text);
        if (term.kind === 'syn') {
          for (const g of groups) if ((SYNONYMS.get(g) ?? new Set()).has(term.text)) coveredGroups.add(g);
        }
      }
    }

    if (score <= 0) continue;

    // Reward documents that cover more of what the user typed.
    if (coreTerms.length > 1) {
      const coverage = coveredGroups.size / groups.length;
      if (coverage < 0.34) score *= 0.35;
      else score *= 0.6 + coverage * 0.8;
    }

    results.push({ index: i, score, hits });
  }

  results.sort((a, b) => b.score - a.score);

  // Drop the long tail: one incidental synonym hit is not a result. The cap
  // keeps a vague query from returning what is effectively the whole program.
  if (results.length) {
    const floor = results[0].score * 0.3;
    return results.filter((r) => r.score >= floor).slice(0, 80);
  }
  return results;
}

/** Terms suitable for highlighting matched text in the UI. */
export function highlightTerms(query) {
  const { terms } = parseQuery(query);
  const rank = { core: 0, syn: 1 };
  return terms
    .filter((t) => t.kind !== 'part' && t.text.length >= 2)
    .sort((a, b) => (rank[a.kind] ?? 2) - (rank[b.kind] ?? 2) || b.text.length - a.text.length)
    .map((t) => t.text)
    .slice(0, 12);
}

// ---------------------------------------------------------------------------
// Intent extraction: pull filter-ish meaning out of a spoken query so that
// "2日目の午前のサウンドの話" narrows the list instead of relying on text match.

const TIME_BANDS = [
  { key: 'morning', label: '午前', from: 0, to: 12 * 60, words: ['午前', 'あさ', '朝', 'モーニング'] },
  { key: 'afternoon', label: '午後', from: 12 * 60, to: 17 * 60, words: ['午後', 'ひる', '昼'] },
  { key: 'evening', label: '夕方以降', from: 17 * 60, to: 24 * 60, words: ['夕方', 'ゆうがた', '夜', 'よる', '夕'] },
];

const DAY_WORDS = [
  { day: 1, words: ['初日', '1日目', '一日目', '7/22', '722', '水曜'] },
  { day: 2, words: ['2日目', '二日目', '中日', '7/23', '723', '木曜'] },
  { day: 3, words: ['3日目', '三日目', '最終日', '7/24', '724', '金曜'] },
];

const LEVEL_WORDS = [
  { level: 1, words: ['初心者', '入門', '基礎', '甘口', '中辛'] },
  { level: 3, words: ['上級', '玄人', '激辛', '深い'] },
];

/**
 * Detect filter intent in a query. Returns { day, band, level, categories, rest }
 * where rest is the query with the recognized parts removed.
 */
export function detectIntent(query, categories) {
  const raw = normalize(query);
  let rest = raw;
  const intent = { day: null, band: null, level: null, categories: [] };

  const take = (word) => {
    const n = normalize(word);
    if (n && rest.includes(n)) {
      rest = rest.replace(n, ' ');
      return true;
    }
    return false;
  };

  for (const d of DAY_WORDS) for (const w of d.words) if (take(w)) intent.day = d.day;
  for (const b of TIME_BANDS) for (const w of b.words) if (take(w)) intent.band = b;
  for (const l of LEVEL_WORDS) for (const w of l.words) if (take(w)) intent.level = l.level;

  for (const c of categories ?? []) {
    // Only match the spelled-out label; bare codes are too short to be safe.
    if (c.label && c.label.length >= 3 && take(c.label)) intent.categories.push(c.code);
  }

  intent.rest = rest.replace(/\s+/g, ' ').trim();
  return intent;
}

/**
 * If the query names a company, return every spelling of it. The caller can
 * then require a speaker match, so "サイゲのAIの話" does not return other
 * studios' AI talks.
 */
export function detectCompany(query) {
  const q = normalize(query);
  for (const group of COMPANY_SEED) {
    for (const word of group) {
      const n = normalize(word);
      if (n.length >= 3 && q.includes(n)) return group.map(normalize).filter(Boolean);
    }
  }
  return null;
}

export { TIME_BANDS };
