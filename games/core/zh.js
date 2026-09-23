/**
 * 界面中文化：策略名 / 动作 / 决策规则 / 结束原因 / 局面摘要。
 *
 * 注意：发给模型的 prompt 仍然是英文 —— 这个 checkpoint 只认英文，我们实测过换中文会退化。
 * 这里只是把"显示给人看的"那部分翻成中文，并把英文原文折叠在「发给模型的内容」里。
 */
import { gridDistance, snakeFacts, wouldDie } from "./snake-core.js";
import { tetrisReward } from "./tetris-core.js";
import { loadAll } from "./records.js";

export const STRATEGY_ZH = {
  chase: "追食物",
  survive: "保活",
  hug: "贴尾巴",
  straight: "直走",
  lines: "消行",
  holes: "补洞",
  flat: "平整",
  low: "压低",
  della: "Dellacherie",
  mixed: "混合",
  heuristic: "启发式",
};

export const ACTION_ZH = { up: "上", down: "下", left: "左", right: "右" };

export const RULE_ZH = {
  "max-reward": "模型奖励分最高",
  "reward-first-tiebreak": "奖励优先兜底",
  "model-strategy": "模型直接选",
  "fallback-chase": "离线兜底（追食物）",
  "fallback-lines": "离线兜底（消行）",
  "fallback-survive": "离线兜底（保活）",
  heuristic: "启发式",
  replay: "回放",
  mock: "模拟",
  offline: "离线",
  "offline-heuristic": "离线启发式",
};

export const CAUSE_ZH = {
  wall: "撞墙",
  self: "咬到自己",
  obstacle: "撞障碍",
  win: "填满棋盘",
  topout: "顶到天花板",
  "garbage-overflow": "被垃圾行顶死",
  autotest: "自测结束",
  reset: "手动重来",
  "no-legal-placement": "无处可放",
  "no-placement": "无处可放",
  "max-steps": "到步数上限",
  "max-pieces": "到块数上限",
  "-": "-",
};

export const zhStrategy = (s) => STRATEGY_ZH[s] ?? s ?? "-";
/** 概率条的标签：先按策略名翻，再按方向名翻 */
export const zhLabel = (k) => STRATEGY_ZH[k] ?? ACTION_ZH[k] ?? k;
export const zhAction = (a) => ACTION_ZH[a] ?? a ?? "-";
export const zhRule = (r) => RULE_ZH[r] ?? r ?? "-";
export const zhCause = (c) => CAUSE_ZH[c] ?? c ?? "-";

/** 把方块的落点 {rot,x} 说成人话 */
export function zhPlacement(action) {
  if (!action || typeof action !== "object") return "-";
  const rot = action.rot ?? 0;
  const rotText = rot === 0 ? "不旋转" : `顺时针转 ${rot} 次`;
  return `${rotText} · 落在第 ${action.x} 列`;
}

/** 贪吃蛇局面摘要（中文，给页面看；发给模型的那份仍是英文） */
export function zhSnakeSituation(state) {
  const head = state.snake[0];
  const facts = snakeFacts(state);
  const bits = [];
  bits.push(`棋盘 ${state.size}×${state.size}`);
  bits.push(`蛇头 第 ${head.x} 列 / 第 ${head.y} 行，朝${zhAction(state.dir)}`);
  bits.push(`身长 ${state.snake.length}`);
  if (state.food) {
    const dx = state.food.x - head.x;
    const dy = state.food.y - head.y;
    const dirs = [];
    if (dx !== 0) dirs.push(`${Math.abs(dx)} 格向${dx > 0 ? "右" : "左"}`);
    if (dy !== 0) dirs.push(`${Math.abs(dy)} 格向${dy > 0 ? "下" : "上"}`);
    const path = gridDistance(state, head, state.food);
    bits.push(`食物 ${dirs.join("、") || "就在头上"}（${path < 0 ? "被挡住，够不着" : `${path} 步`}）`);
  } else {
    bits.push("食物已吃完");
  }
  bits.push(`可达空格 ${facts.freeSpace}`);
  if (state.obstacles?.length) bits.push(`障碍 ${state.obstacles.length} 个`);
  const rule = state.difficultyRule;
  if (rule) {
    const extra = [];
    if (rule.shrinkEvery) extra.push(`每 ${rule.shrinkEvery} 个食物收 1 圈`);
    if (rule.foodExpiresAfter) extra.push(`食物 ${rule.foodExpiresAfter} 步过期`);
    if (rule.accelEvery) extra.push(`每 ${rule.accelEvery} 个食物加速`);
    bits.push(`难度「${rule.label}」${extra.length ? `（${extra.join("，")}）` : ""}`);
  }
  if (wouldDie(state, state.dir)) bits.push("⚠️ 继续朝这个方向会立刻死");
  return bits.join("；");
}

/** 方块局面摘要（中文） */
export function zhTetrisSituation(state) {
  const heights = [];
  for (let x = 0; x < state.w; x++) {
    let hgt = 0;
    for (let y = 0; y < state.h; y++) {
      if (state.board[y][x] !== 0) {
        hgt = state.h - y;
        break;
      }
    }
    heights.push(hgt);
  }
  let holes = 0;
  for (let x = 0; x < state.w; x++) {
    let seen = false;
    for (let y = 0; y < state.h; y++) {
      if (state.board[y][x] !== 0) seen = true;
      else if (seen) holes++;
    }
  }
  const topRow = state.board.findIndex((row) => row.some((v) => v !== 0));
  const reward = tetrisReward(state);
  const bits = [];
  bits.push(`棋盘 ${state.w} 列 × ${state.h} 行`);
  bits.push(`各列高度 ${heights.join("/")}`);
  bits.push(topRow < 0 ? "当前空盘" : `最高块在第 ${topRow} 行（上方还剩 ${topRow} 行）`);
  bits.push(`空洞 ${holes} 个`);
  bits.push(`消行 ${state.lines}｜奖励 ${reward.lines}｜已放 ${state.pieces} 块｜每块 ${reward.perPiece} 行`);
  bits.push(`当前块 ${state.piece?.type ?? "?"}（旋转态 ${state.piece?.rot ?? 0}）｜下一块 ${state.next?.type ?? state.next ?? "?"}`);
  const rule = state.difficultyRule;
  if (rule) {
    const extra = [];
    if (rule.garbageEvery) extra.push(`每 ${rule.garbageEvery} 块涨 1 行垃圾`);
    if (rule.bag === "sz") extra.push("只发 S/Z");
    if (rule.startRows) extra.push(`开局垫 ${rule.startRows} 行垃圾`);
    bits.push(`难度「${rule.label}」${extra.length ? `（${extra.join("，")}）` : ""}`);
  }
  return bits.join("；");
}

/** 会话经验的中文版（发给模型的仍是英文那句） */
export function sessionLessonZh(game, { limit = 5 } = {}) {
  const list = (loadAll()[game] ?? []).slice(-limit);
  if (list.length === 0) return null;
  const unit = game === "snake" ? "食物" : "分";
  const byStrategy = new Map();
  for (const rec of list) {
    const key = rec.strategy ?? (rec.engine === "heuristic" ? "heuristic" : "unknown");
    if (!byStrategy.has(key)) byStrategy.set(key, []);
    byStrategy.get(key).push(rec.score ?? 0);
  }
  const parts = [];
  for (const [strategy, scores] of byStrategy) {
    const avg = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
    parts.push(`${zhStrategy(strategy)}主导 ${scores.length} 局：${scores.join("/")} ${unit}（平均 ${avg}）`);
  }
  return `本会话经验（前 ${list.length} 局）：${parts.join("；")}`;
}
