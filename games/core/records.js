/**
 * 游戏记录层：全部存在浏览器 localStorage（用户要求"浏览器缓存游戏记录"）。
 *
 * 结构：{ snake: [record...], tetris: [record...] }
 * record：{ id, game, engine, mode, score, detail, steps, durationMs, at }
 * engine：human | laya | heuristic | router | local（页面本地启发式）
 */
const KEY = "laya-router.records.v1";
const LIMIT_PER_GAME = 300;

export const ENGINE_LABELS = {
  human: "人类",
  laya: "Laya",
  "laya-strategy": "Laya·策略",
  router: "路由器",
  heuristic: "启发式",
  local: "本地启发式",
};

function emptyDb() {
  return { snake: [], tetris: [] };
}

export function loadAll() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyDb();
    const parsed = JSON.parse(raw);
    return { snake: parsed?.snake ?? [], tetris: parsed?.tetris ?? [] };
  } catch {
    return emptyDb();
  }
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

export function summary(game) {
  const list = loadAll()[game] ?? [];
  const humans = list.filter((r) => r.engine === "human");
  const machines = list.filter((r) => r.engine !== "human");
  const avg = (arr) => (arr.length ? Math.round((arr.reduce((s, r) => s + (r.score ?? 0), 0) / arr.length) * 10) / 10 : 0);
  return {
    plays: list.length,
    humanPlays: humans.length,
    machinePlays: machines.length,
    best: list.reduce((m, r) => Math.max(m, r.score ?? 0), 0),
    humanBest: humans.reduce((m, r) => Math.max(m, r.score ?? 0), 0),
    machineBest: machines.reduce((m, r) => Math.max(m, r.score ?? 0), 0),
    humanAvg: avg(humans),
    machineAvg: avg(machines),
    bestByEngine: bestByEngine(game),
  };
}

/**
 * 会话经验：把最近几局的「主导策略 → 得分」压成一句话，塞进下一局的环境报告。
 * 模型本身没有记忆，靠这句 prompt 里的经验来"影响新的一局"。
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
  localStorage.removeItem(KEY);
}

export function exportAll() {
  return JSON.stringify(loadAll(), null, 2);
}
