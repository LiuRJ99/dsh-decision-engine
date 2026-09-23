/**
 * 俄罗斯方块纯逻辑核心（SRS 形状 + 7-bag 随机 + 简单锁定时不踢墙）。
 *
 * 浏览器页面和 Node 测试共用同一份规则。board[y][x]：0 = 空，否则是方块字母（用于上色）。
 */

export const TETRIS = { w: 10, h: 20 };

/**
 * 难度档（都按游戏本身的规则加压，不是让 AI 变笨）：
 *   startRows   开局在底部垫几行垃圾行（每行留一个洞）
 *   garbageEvery 每放 N 块，从底部顶上来 garbageRows 行垃圾；顶到天花板就算顶死
 *   bag         方块序列：normal = 7-bag；sz = 只有 S/Z（极难）
 */
export const TETRIS_DIFFICULTIES = {
  // 括号里是用 lines 执行器实测的平均存活块数（3 个种子、上限 500 块）
  easy: { label: "简单", startRows: 0, garbageEvery: 0, garbageRows: 0, bag: "normal" }, // 500+（死不了）
  normal: { label: "普通", startRows: 4, garbageEvery: 12, garbageRows: 1, bag: "normal" }, // ≈383
  hard: { label: "困难", startRows: 4, garbageEvery: 6, garbageRows: 1, bag: "normal" }, // ≈148
  extreme: { label: "极限", startRows: 4, garbageEvery: 6, garbageRows: 1, bag: "sz" }, // ≈43（只有 S/Z）
};
export const PIECE_TYPES = ["I", "O", "T", "S", "Z", "J", "L"];
export const PIECE_COLORS = {
  I: "#4dd0e1",
  O: "#ffd54f",
  T: "#ba68c8",
  S: "#81c784",
  Z: "#e57373",
  J: "#64b5f6",
  L: "#ffb74d",
  G: "#6b7280", // 垃圾行
};

/** 4 个旋转态，每态是若干 [dx, dy]（相对 piece 原点，原点在包围盒左上）。 */
export const PIECES = {
  I: [
    [[0, 1], [1, 1], [2, 1], [3, 1]],
    [[2, 0], [2, 1], [2, 2], [2, 3]],
    [[0, 2], [1, 2], [2, 2], [3, 2]],
    [[1, 0], [1, 1], [1, 2], [1, 3]],
  ],
  O: [
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
  ],
  T: [
    [[1, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [1, 2]],
    [[1, 0], [0, 1], [1, 1], [1, 2]],
  ],
  S: [
    [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[1, 0], [1, 1], [2, 1], [2, 2]],
    [[1, 1], [2, 1], [0, 2], [1, 2]],
    [[0, 0], [0, 1], [1, 1], [1, 2]],
  ],
  Z: [
    [[0, 0], [1, 0], [1, 1], [2, 1]],
    [[2, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [1, 2], [2, 2]],
    [[1, 0], [0, 1], [1, 1], [0, 2]],
  ],
  J: [
    [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [2, 2]],
    [[1, 0], [1, 1], [0, 2], [1, 2]],
  ],
  L: [
    [[2, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [1, 2], [2, 2]],
    [[0, 1], [1, 1], [2, 1], [0, 2]],
    [[0, 0], [1, 0], [1, 1], [1, 2]],
  ],
};

export function createRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function emptyBoard(w = TETRIS.w, h = TETRIS.h) {
  return Array.from({ length: h }, () => new Array(w).fill(0));
}

function shuffledBag(rng, types = PIECE_TYPES) {
  const bag = types.slice();
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

export function createTetrisState({ w = TETRIS.w, h = TETRIS.h, seed = 1, rng, difficulty = "normal" } = {}) {
  const random = rng ?? createRng(seed);
  const level = TETRIS_DIFFICULTIES[difficulty] ?? TETRIS_DIFFICULTIES.normal;
  const state = {
    w,
    h,
    difficulty,
    difficultyRule: level,
    board: emptyBoard(w, h),
    bag: [],
    piece: null,
    next: null,
    score: 0,
    lines: 0,
    level: 1,
    pieces: 0,
    alive: true,
    cause: null,
    rng: random,
  };
  if (level.startRows > 0) pushGarbage(state, level.startRows);
  state.piece = spawnPiece(state);
  state.next = spawnPiece(state);
  return state;
}

/** 从底部顶上来 rows 行垃圾行（每行留一个随机洞）；顶出棋盘就顶死。 */
export function pushGarbage(state, rows) {
  const rule = state.difficultyRule ?? TETRIS_DIFFICULTIES.normal;
  for (let i = 0; i < rows; i++) {
    const hole = Math.floor(state.rng() * state.w);
    const garbage = new Array(state.w).fill("G");
    garbage[hole] = 0;
    // 整体上移一行；被挤出顶部的行如果有方块，就算顶死
    const overflow = state.board[0].some((v) => v !== 0);
    state.board.shift();
    state.board.push(garbage);
    if (overflow) {
      state.alive = false;
      state.cause = "garbage-overflow";
      return false;
    }
  }
  void rule;
  return true;
}

function drawType(state) {
  if (state.bag.length === 0) state.bag = shuffledBag(state.rng, bagFor(state));
  return state.bag.pop();
}

export function spawnPiece(state) {
  return { type: drawType(state), rot: 0, x: 3, y: 0 };
}

function bagFor(state) {
  const rule = state.difficultyRule ?? TETRIS_DIFFICULTIES.normal;
  return rule.bag === "sz" ? ["S", "Z"] : PIECE_TYPES;
}

export function tetrisSnapshot(state) {
  return {
    w: state.w,
    h: state.h,
    difficulty: state.difficulty ?? "normal",
    difficultyRule: state.difficultyRule ?? null,
    board: state.board.map((row) => row.slice()),
    piece: state.piece ? { ...state.piece } : null,
    next: state.next,
    score: state.score,
    lines: state.lines,
    level: state.level,
    pieces: state.pieces,
    alive: state.alive,
    cause: state.cause,
  };
}

export function tetrisFromSnapshot(snap, rng = createRng(1)) {
  return { ...snap, board: snap.board.map((r) => r.slice()), piece: snap.piece ? { ...snap.piece } : null, bag: [], rng };
}

export function tetrisCells(type, rot, x, y) {
  return PIECES[type][((rot % 4) + 4) % 4].map(([dx, dy]) => ({ x: x + dx, y: y + dy }));
}

export function tetrisCollides(state, cells) {
  for (const c of cells) {
    if (c.x < 0 || c.x >= state.w || c.y >= state.h) return true;
    if (c.y >= 0 && state.board[c.y][c.x] !== 0) return true;
  }
  return false;
}

/** 从 y=0 自由下落，返回最终落点（原点 y）。 */
export function tetrisDropY(state, type, rot, x) {
  let y = 0;
  if (tetrisCollides(state, tetrisCells(type, rot, x, y))) return null;
  while (!tetrisCollides(state, tetrisCells(type, rot, x, y + 1))) y++;
  return y;
}

/** 所有合法落点（旋转 × 列），已按"能放得下"过滤。 */
export function tetrisLegalPlacements(state, type = state.piece?.type) {
  if (!type) return [];
  const out = [];
  for (let rot = 0; rot < 4; rot++) {
    const shape = PIECES[type][rot];
    const minDx = Math.min(...shape.map(([dx]) => dx));
    const maxDx = Math.max(...shape.map(([dx]) => dx));
    for (let x = -minDx; x <= state.w - 1 - maxDx; x++) {
      const y = tetrisDropY(state, type, rot, x);
      if (y == null) continue;
      if (!out.some((p) => p.rot === rot && p.x === x)) out.push({ rot, x, y });
    }
  }
  return out;
}

/** 把一个落点放上去，统计落地后的盘面指标（不修改 state）。 */
export function tetrisPlacementFacts(state, { rot, x }, type = state.piece?.type) {
  const y = tetrisDropY(state, type, rot, x);
  if (y == null) return null;
  const board = state.board.map((row) => row.slice());
  const cells = tetrisCells(type, rot, x, y);
  for (const c of cells) board[c.y][c.x] = type;
  const fullRows = [];
  for (let yy = 0; yy < state.h; yy++) if (board[yy].every((v) => v !== 0)) fullRows.push(yy);
  const cleared = fullRows.length;
  const kept = board.filter((_, yy) => !fullRows.includes(yy));
  while (kept.length < state.h) kept.unshift(new Array(state.w).fill(0));
  const erodedPieceCells = cells.filter((c) => fullRows.includes(c.y)).length;
  const heights = [];
  for (let xx = 0; xx < state.w; xx++) {
    let hgt = 0;
    for (let yy = 0; yy < state.h; yy++) {
      if (kept[yy][xx] !== 0) {
        hgt = state.h - yy;
        break;
      }
    }
    heights.push(hgt);
  }
  let holes = 0;
  for (let xx = 0; xx < state.w; xx++) {
    let seenBlock = false;
    for (let yy = 0; yy < state.h; yy++) {
      if (kept[yy][xx] !== 0) seenBlock = true;
      else if (seenBlock) holes++;
    }
  }
  let bumpiness = 0;
  for (let xx = 0; xx + 1 < state.w; xx++) bumpiness += Math.abs(heights[xx] - heights[xx + 1]);
  const aggHeight = heights.reduce((a, b) => a + b, 0);
  const landingHeight = state.h - Math.min(...cells.map((c) => c.y));
  return {
    rot,
    x,
    y,
    type,
    cells,
    board: kept,
    heights,
    cleared,
    erodedPieceCells,
    holes,
    bumpiness,
    aggHeight,
    maxHeight: Math.max(...heights),
    landingHeight,
    rowTransitions: countRowTransitions(kept, state.w, state.h),
    columnTransitions: countColumnTransitions(kept, state.w, state.h),
    wellSums: computeWellSums(kept, state.w, state.h),
  };
}

/** 行内"空↔实"切换次数（左右边界按实心墙算）。 */
function countRowTransitions(board, w, h) {
  let transitions = 0;
  for (let y = 0; y < h; y++) {
    let prev = 1;
    for (let x = 0; x < w; x++) {
      const cur = board[y][x] !== 0 ? 1 : 0;
      if (cur !== prev) transitions++;
      prev = cur;
    }
    if (prev === 0) transitions++;
  }
  return transitions;
}

/** 列内"空↔实"切换次数（底部按实心算，顶部按空算）。 */
function countColumnTransitions(board, w, h) {
  let transitions = 0;
  for (let x = 0; x < w; x++) {
    let prev = 0;
    for (let y = 0; y < h; y++) {
      const cur = board[y][x] !== 0 ? 1 : 0;
      if (cur !== prev) transitions++;
      prev = cur;
    }
    if (prev === 0) transitions++;
  }
  return transitions;
}

/** 井：上方为空、左右都被挡住的竖井深度之和。 */
function computeWellSums(board, w, h) {
  let sums = 0;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      if (board[y][x] !== 0) continue;
      const leftFilled = x === 0 || board[y][x - 1] !== 0;
      const rightFilled = x === w - 1 || board[y][x + 1] !== 0;
      if (!leftFilled || !rightFilled) continue;
      let depth = 0;
      for (let yy = y; yy < h && board[yy][x] === 0; yy++) depth++;
      sums += (depth * (depth + 1)) / 2;
      break;
    }
  }
  return sums;
}

/** Dellacherie 评分（业界经典权重）：消行与落地位置优先，压制空洞/井/列内起伏。 */
export function tetrisHeuristicScore(f) {
  return (
    -4.500158825082766 * f.landingHeight +
    3.4181268101392694 * f.erodedPieceCells -
    3.2178882868487753 * f.rowTransitions -
    9.348695305445199 * f.columnTransitions -
    7.899265427351652 * f.holes -
    3.3855972247263626 * f.wellSums
  );
}

export function tetrisHeuristicPlacement(state) {
  const legal = tetrisLegalPlacements(state);
  if (legal.length === 0) return null;
  let best = null;
  for (const p of legal) {
    const f = tetrisPlacementFacts(state, p);
    if (!f) continue;
    const score = tetrisHeuristicScore(f);
    if (!best || score > best.score) best = { score, placement: { rot: p.rot, x: p.x }, facts: f };
  }
  return best;
}

/** 落子：写盘、消行、re-spawn。返回本手事件。 */
export function tetrisApplyPlacement(state, { rot, x }, type = state.piece?.type) {
  const f = tetrisPlacementFacts(state, { rot, x }, type);
  if (!f) return { ok: false, reason: "illegal" };
  state.board = f.board;
  state.pieces++;
  if (f.cleared > 0) {
    state.lines += f.cleared;
    state.score += [0, 100, 300, 500, 800][f.cleared] * state.level;
    state.level = Math.floor(state.lines / 10) + 1;
  }
  const rule = state.difficultyRule ?? TETRIS_DIFFICULTIES.normal;
  if (rule.garbageEvery > 0 && state.pieces % rule.garbageEvery === 0 && state.alive) {
    pushGarbage(state, rule.garbageRows);
    if (!state.alive) return { ok: true, cleared: f.cleared, facts: f, topOut: true, garbage: true };
  }
  state.piece = state.next ?? spawnPiece(state);
  state.next = spawnPiece(state);
  if (tetrisCollides(state, tetrisCells(state.piece.type, state.piece.rot, state.piece.x, state.piece.y))) {
    state.alive = false;
    state.cause = "topout";
  }
  return { ok: true, cleared: f.cleared, facts: f, topOut: !state.alive };
}

/* ---------- 人类操作（重力下落 / 左右 / 旋转） ---------- */

export function tetrisMove(state, dx) {
  if (!state.alive || !state.piece) return false;
  const p = { ...state.piece, x: state.piece.x + dx };
  if (tetrisCollides(state, tetrisCells(p.type, p.rot, p.x, p.y))) return false;
  state.piece = p;
  return true;
}

export function tetrisRotate(state, dir = 1) {
  if (!state.alive || !state.piece) return false;
  const rot = (((state.piece.rot + dir) % 4) + 4) % 4;
  const kicks = [0, -1, 1, -2, 2];
  for (const k of kicks) {
    const p = { ...state.piece, rot, x: state.piece.x + k };
    if (!tetrisCollides(state, tetrisCells(p.type, p.rot, p.x, p.y))) {
      state.piece = p;
      return true;
    }
  }
  return false;
}

/** 重力走一格；落不下去就锁定。 */
export function tetrisStepDown(state) {
  if (!state.alive || !state.piece) return { locked: false };
  const p = { ...state.piece, y: state.piece.y + 1 };
  if (!tetrisCollides(state, tetrisCells(p.type, p.rot, p.x, p.y))) {
    state.piece = p;
    return { locked: false };
  }
  const res = tetrisApplyPlacement(state, { rot: state.piece.rot, x: state.piece.x });
  return { locked: true, ...res };
}

export function tetrisHardDrop(state) {
  if (!state.alive || !state.piece) return null;
  return tetrisApplyPlacement(state, { rot: state.piece.rot, x: state.piece.x });
}

/* ---------- 给 Laya 的状态与问题 ---------- */

export function tetrisLayaState(state, { maxRows = 12 } = {}) {
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
  const from = topRow < 0 ? state.h - 4 : Math.max(0, Math.min(topRow, state.h - maxRows));
  const rows = state.board.slice(from).map((row) => row.map((v) => (v === 0 ? "." : "#")).join(""));
  return {
    board_rows_from_top: state.h - from,
    stack: rows,
    column_heights: heights,
    holes,
    current_piece: state.piece?.type ?? null,
    current_rotation: state.piece?.rot ?? null,
    next_piece: state.next?.type ?? state.next,
    lines_cleared: state.lines,
    level: state.level,
  };
}

function placementText(f) {
  return `lands at height ${f.landingHeight}, clears ${f.cleared} line(s), leaves ${f.holes} hole(s), bumpiness ${f.bumpiness}, stack height ${f.aggHeight}`;
}

/** Laya 的两段式决策：先选旋转，再选落点列。bare=true 时选项只给标签（事实由 proso 状态交代）。 */
export function tetrisQuestions(state, stage, { bare = false } = {}) {
  if (stage === "rotation") {
    // 只保留"有合法落点、且形状和前面不重复"的旋转态（O 的 4 个态、I/S/Z 的对称态会被去掉）
    const seen = new Set();
    const criteria = {};
    for (const p of tetrisLegalPlacements(state)) {
      const signature = PIECES[state.piece.type][p.rot].map(([dx, dy]) => `${dx},${dy}`).join("|");
      if (seen.has(signature)) continue;
      seen.add(signature);
      criteria[`r${p.rot}`] = p.rot === 0 ? "spawn orientation" : `rotated ${p.rot} turn(s) from spawn`;
    }
    return {
      rotation: {
        type: "choice",
        instructions: `You are playing Tetris. The current piece is ${state.piece.type}. Which rotation should it use before dropping?`,
        criteria,
      },
      stack_danger: {
        type: "noul",
        instructions: "Is the stack close to topping out (is the game about to end)?",
        criteria: { true: "the stack is nearly at the top", false: "there is still plenty of vertical room" },
      },
    };
  }
  const criteria = {};
  for (let x = 0; x < state.w; x++) {
    const f = tetrisPlacementFacts(state, { rot: state.piece.rot, x });
    criteria[`column ${x}`] = bare ? (f ? "possible landing column" : "cannot be reached") : f ? placementText(f) : "cannot be reached";
  }
  return {
    column: {
      type: "choice",
      instructions: `You are playing Tetris. The ${state.piece.type} piece is rotated to state ${state.piece.rot}. In which column should it land?`,
      criteria,
    },
  };
}

/**
 * 第三种状态表示：把"现状"用自然语言讲一遍（盘面多高、每列多高、有几个洞、当前块是什么、
 * 下一块是什么、消行规则），再让模型判断这一块该放哪 —— 选项可以只给列号。
 */
export function tetrisProseState(state) {
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
  let bumpiness = 0;
  for (let x = 0; x + 1 < state.w; x++) bumpiness += Math.abs(heights[x] - heights[x + 1]);
  const topRow = state.board.findIndex((row) => row.some((v) => v !== 0));
  const type = state.piece?.type ?? "?";
  const next = state.next?.type ?? state.next ?? "?";
  const parts = [];
  parts.push(
    `You are playing Tetris on a board that is ${state.w} columns wide (column 0 is the left edge) and ${state.h} rows tall (row 0 is the top).`,
  );
  parts.push(`Column heights from left to right are ${heights.join(", ")}, where 0 means the column is completely empty.`);
  parts.push(
    topRow < 0
      ? "The board is still completely empty."
      : `The highest block sits at row ${topRow}, so there are ${topRow} empty rows above the stack.`,
  );
  parts.push(`The stack currently contains ${holes} covered holes and ${bumpiness} cells of surface unevenness in total.`);
  parts.push(`The piece to place now is a ${type} in rotation state ${state.piece?.rot ?? 0} (0 is the spawn orientation), and the next piece will be a ${next}.`);
  parts.push("A piece always drops straight down inside whichever column you choose, and every row that becomes completely filled disappears.");
  parts.push(`So far ${state.pieces} pieces have been placed, ${state.lines} lines cleared, level ${state.level}.`);
  return parts.join(" ");
}

/** 按表示法选状态：grid（ASCII 盘面）/ prose（自然语言现状） */
export function tetrisStateByStyle(state, style = "prose") {
  return style === "grid" ? tetrisLayaState(state) : tetrisProseState(state);
}

/* ================= 策略决策 + 奖励（与贪吃蛇同一套思路） ================= */

export const TETRIS_STRATEGIES = ["lines", "holes", "flat", "low"];

/** 奖励规则：消一行 +100，顶到天花板 -1000。 */
export const TETRIS_REWARD = { line: 100, topout: -1000 };

export function tetrisReward(state) {
  const lines = state.lines * TETRIS_REWARD.line;
  const topout = state.alive ? 0 : TETRIS_REWARD.topout;
  return { lines, topout, total: lines + topout, perPiece: state.pieces > 0 ? Math.round((state.lines / state.pieces) * 1000) / 1000 : 0 };
}

/** 环境报告：盘面 + 规则 + 奖励现状，作为 state 交给模型。 */
export function tetrisEnvironmentCard(state) {
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
  let bumpiness = 0;
  for (let x = 0; x + 1 < state.w; x++) bumpiness += Math.abs(heights[x] - heights[x + 1]);
  const topRow = state.board.findIndex((row) => row.some((v) => v !== 0));
  const reward = tetrisReward(state);
  const lines = [];
  lines.push(`Environment: a Tetris board ${state.w} columns wide (column 0 is the left edge) and ${state.h} rows tall (row 0 is the top).`);
  lines.push(`Column heights from left to right: ${heights.join(", ")} (0 means the column is empty).`);
  lines.push(
    topRow < 0
      ? "The board is completely empty."
      : `The highest block is at row ${topRow}, so ${topRow} empty rows remain above the stack.`,
  );
  lines.push(`The stack contains ${holes} covered holes and ${bumpiness} cells of surface unevenness.`);
  lines.push(
    `The piece to place now is a ${state.piece?.type ?? "?"} in rotation state ${state.piece?.rot ?? 0}, and the next piece will be a ${state.next?.type ?? state.next ?? "?"}. ` +
      "A piece always drops straight down in the chosen column, and every completely filled row disappears.",
  );
  lines.push(
    `Reward: +${TETRIS_REWARD.line} per row cleared, ${TETRIS_REWARD.topout} when the stack reaches the top. ` +
      `Current score: ${state.lines} rows cleared (${reward.lines} reward points) after ${state.pieces} pieces.`,
  );
  const rule = state.difficultyRule;
  if (rule && (rule.garbageEvery > 0 || rule.bag === "sz")) {
    lines.push(
      `Difficulty: ${rule.label}` +
        (rule.bag === "sz" ? "，only S and Z pieces are dealt" : "") +
        (rule.garbageEvery > 0 ? `，a garbage row rises from the bottom every ${rule.garbageEvery} pieces` : "") +
        ".",
    );
  }
  return lines.join(" ");
}

/** 四个策略在这里分别意味着什么。 */
export function tetrisStrategyCriteria(state) {
  const card = tetrisProseState(state);
  void card;
  return {
    lines: `clear rows with this piece: choose the landing that removes the most complete rows now (+${TETRIS_REWARD.line} per row)`,
    holes: "avoid covering empty cells: choose the landing that leaves the fewest covered holes underneath the stack",
    flat: "keep the surface even: choose the landing that leaves the flattest surface, so future pieces fit easily",
    low: "keep the stack low: choose the landing that keeps the total stack height smallest",
  };
}

/**
 * 每个策略的评分：**都用 Dellacherie 打底**（保证四个策略都会玩），再叠加各自的侧重。
 * 之前是"单一指标"（只看洞 / 只看平整度…），实测每块只消 0.19–0.21 行、50–60 块就顶死，
 * 而带生存项的组合评分是 0.40 行/块、300 块不死。见 test/tetris-strategy-quality.mjs。
 */
export function tetrisStrategyScore(strategy, f) {
  const base = tetrisHeuristicScore(f);
  switch (strategy) {
    case "lines":
      return base + 12 * f.cleared + 3 * f.erodedPieceCells; // 现在能消就消
    case "holes":
      return base - 6 * f.holes; // 更怕挖洞
    case "flat":
      return base - 2 * f.bumpiness; // 更怕表面凹凸
    case "low":
      return base - 0.8 * f.aggHeight; // 更怕堆高
    default:
      return base;
  }
}

/** 把策略翻译成具体落点（平局按"消行多 → 洞少 → 堆低 → 列靠左"确定性打破）。 */
export function tetrisStrategyPlacement(state, strategy) {
  const legal = tetrisLegalPlacements(state);
  if (legal.length === 0) return null;
  const scored = legal
    .map((p) => ({ p, f: tetrisPlacementFacts(state, p) }))
    .filter((x) => x.f);
  if (scored.length === 0) return null;
  const better = (a, b) => {
    const sa = tetrisStrategyScore(strategy, a.f);
    const sb = tetrisStrategyScore(strategy, b.f);
    if (sb !== sa) return sb > sa ? b : a;
    if (b.f.cleared !== a.f.cleared) return b.f.cleared > a.f.cleared ? b : a;
    if (b.f.holes !== a.f.holes) return b.f.holes < a.f.holes ? b : a;
    if (b.f.aggHeight !== a.f.aggHeight) return b.f.aggHeight < a.f.aggHeight ? b : a;
    return a.p.x <= b.p.x ? a : b;
  };
  const best = scored.reduce((a, b) => better(a, b));
  return { rot: best.p.rot, x: best.p.x, facts: pickFacts(best.f) };
}

export function tetrisStrategyPreview(state) {
  const out = {};
  for (const strategy of TETRIS_STRATEGIES) {
    const p = tetrisStrategyPlacement(state, strategy);
    out[strategy] = p ? { rot: p.rot, x: p.x } : null;
  }
  return out;
}

function pickFacts(f) {
  return { rot: f.rot, x: f.x, cleared: f.cleared, holes: f.holes, bumpiness: f.bumpiness, aggHeight: f.aggHeight };
}
