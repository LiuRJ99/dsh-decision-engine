/**
 * 游戏记录层：浏览器 localStorage。
 *
 * 记录归**页面**持有 —— 因为游戏本身就跑在页面里（没有后端）。两点因此成立：
 *
 * - 两个游戏现在跑在**同一个 origin**（`games/serve.mjs` 一个端口同时服务它们），
 *   所以 localStorage 是同一份，一个页面看得到另一个游戏的成绩。
 *   （之前桥的版本是 :8787 / :8788 两个 origin，各存各的，互相看不见 —— 实测踩到过。）
 * - 页面开着才记得到；这不再是问题，因为游戏也跑在这里。
 *
 * 结构：{ snake: [record...], tetris: [record...] }
 * record：{ id, game, engine, mode, strategy, score, detail, difficulty, at }
 *
 * 新键是 `dsh-decision-engine.records.v1`；旧键 `laya-router.records.v1` 只读兼容，
 * 里面可能还有迁移前留下的记录。
 */
const KEY = "dsh-decision-engine.records.v1";
const LEGACY_KEY = "laya-router.records.v1";
const LIMIT_PER_GAME = 300;
/** 只有这两个游戏；分桶、去重、合并都按它遍历。 */
const GAMES = ["snake", "tetris"];

export const ENGINE_LABELS = {
  human: "人类",
  "decision-layer": "决策层",
  mixed: "混合",
  laya: "Laya",
  "laya-strategy": "Laya·策略",
  router: "路由器",
  heuristic: "启发式",
  local: "本地启发式",
};

function emptyDb() {
  return { snake: [], tetris: [] };
}

/**
 * 把"存过的形状"收成 { snake, tetris }。认不出来就返回 null —— 调用方会去试下一个键。
 *
 * 两种形状都见过：
 * - `{ snake: [...], tetris: [...] }` —— 现在的形状；
 * - **扁平数组** `[{ game: "snake", ... }, ...]` —— 早期版本直接这么存。
 *   只认对象形状的话，新键里的扁平数组会被读成"两个空列表"，而且因为新键优先、
 *   不会再回退旧键 —— 记录看起来就像丢了（实测踩到）。
 */
function normalize(raw) {
  if (raw == null || typeof raw !== "object") return null;
  if (Array.isArray(raw)) {
    const db = emptyDb();
    for (const rec of raw) {
      if (rec !== null && typeof rec === "object" && (rec.game === "snake" || rec.game === "tetris")) db[rec.game].push(rec);
    }
    return db;
  }
  let seen = false;
  const db = emptyDb();
  for (const game of GAMES) {
    if (Array.isArray(raw[game])) { db[game] = raw[game]; seen = true; }
  }
  return seen ? db : null;
}

/** 读一个键并收成 db；读不出来（没有 / 坏数据 / 认不出的形状）返回 null。 */
function readKey(key) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null || raw === "") return null;
    return normalize(JSON.parse(raw));
  } catch {
    return null;
  }
}

const MIGRATED_KEY = "dsh-decision-engine.records.migrated.v1";

/**
 * 一次性把**旧键**里的记录并进新键。
 *
 * 旧键是桥时代攒下的对局；新键一旦有数据就会优先，旧键再也读不到 ——
 * 换了个键，历史看起来就像丢了（实测：旧键 1278 字符的记录完全不可见）。
 * 只并一次（标记位），按 id 去重，合并失败不影响读取。
 */
function migrateLegacyOnce() {
  try {
    if (localStorage.getItem(MIGRATED_KEY) === "1") return;
    const legacy = readKey(LEGACY_KEY);
    if (legacy !== null) {
      const mine = readKey(KEY) ?? emptyDb();
      const seen = new Set();
      for (const game of GAMES) for (const rec of mine[game]) seen.add(rec?.id);
      let added = 0;
      for (const game of GAMES) {
        for (const rec of legacy[game]) {
          if (rec?.id !== undefined && seen.has(rec.id)) continue;
          mine[game].push(rec);
          added += 1;
        }
      }
      if (added > 0) save(mine);
    }
    localStorage.setItem(MIGRATED_KEY, "1");
  } catch { /* 迁移失败不影响读取 */ }
}

migrateLegacyOnce();

export function loadAll() {
  return readKey(KEY) ?? readKey(LEGACY_KEY) ?? emptyDb();
}

function save(db) {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
    return true;
  } catch {
    return false;
  }
}

export function addRecord(game, record) {
  const db = loadAll();
  const entry = {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    at: new Date().toISOString(),
    ...record,
  };
  const list = db[game] ?? (db[game] = []);
  list.push(entry);
  if (list.length > LIMIT_PER_GAME) list.splice(0, list.length - LIMIT_PER_GAME);
  save(db);
  return entry;
}

export function listRecords(game) {
  const list = loadAll()[game] ?? [];
  return list.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || String(b.at).localeCompare(String(a.at)));
}

export function recentRecords(game, n = 8) {
  const list = loadAll()[game] ?? [];
  return list.slice(-n).reverse();
}

export function bestByEngine(game) {
  const out = {};
  for (const rec of loadAll()[game] ?? []) {
    const key = rec.engine ?? "human";
    if (out[key] == null || (rec.score ?? 0) > out[key]) out[key] = rec.score ?? 0;
  }
  return out;
}

/** 按难度统计最好成绩（主页总览用） */
export function bestByDifficulty(game) {
  const out = {};
  for (const rec of loadAll()[game] ?? []) {
    const key = rec.difficulty ?? "unknown";
    if (out[key] == null || (rec.score ?? 0) > out[key]) out[key] = rec.score ?? 0;
  }
  return out;
}

/** 主页两行摘要：共几局、最高分、各引擎分布。 */
export function summary(game) {
  const list = loadAll()[game] ?? [];
  if (list.length === 0) return { total: 0, best: 0, byEngine: {} };
  const byEngine = bestByEngine(game);
  return { total: list.length, best: Math.max(...list.map((r) => r.score ?? 0)), byEngine };
}

/**
 * 会话经验：把最近几局的「主导策略 → 得分」压成一句话。
 * 现在没有"下一次决策"可影响（决策层读的是页面文字），保留它是为了在页面上显示。
 */
export function sessionLesson(game, { limit = 5 } = {}) {
  const list = (loadAll()[game] ?? []).slice(-limit);
  if (list.length === 0) return null;
  const unit = game === "snake" ? "food" : "points";
  const byStrategy = new Map();
  for (const rec of list) {
    const key = rec.strategy ?? (rec.engine === "heuristic" ? "heuristic" : "unknown");
    if (!byStrategy.has(key)) byStrategy.set(key, []);
    byStrategy.get(key).push(rec.score ?? 0);
  }
  const parts = [];
  for (const [strategy, scores] of byStrategy) {
    const avg = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
    parts.push(`${strategy}-led: ${scores.length} game(s), ${scores.join("/")} ${unit} (avg ${avg})`);
  }
  return `Experience from your earlier games in this session — ${parts.join("; ")}.`;
}

export function clearAll() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(LEGACY_KEY);
    localStorage.removeItem(MIGRATED_KEY);
  } catch { /* 忽略 */ }
}

export function exportAll() {
  return JSON.stringify(loadAll(), null, 2);
}
