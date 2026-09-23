/**
 * 贪吃蛇纯逻辑核心。
 *
 * 浏览器页面和 Node 测试共用同一份规则，保证"人类玩的"和"NPC 玩的"是同一个游戏。
 * 本模块不允许 import 任何浏览器 / Node 专有 API。坐标：x 向右、y 向下，snake[0] 是蛇头。
 */

export const ACTIONS = ["up", "down", "left", "right"];

/**
 * 难度档（按贪吃蛇自己的规则加压，不是让 AI 变笨）：
 *   obstacles        棋盘上随机障碍物格数
 *   accelEvery       每吃 N 个食物加速一档（页面按 stepMs 递减执行）
 *   stepMs           基础每步毫秒；minStepMs 是加速下限
 *   foodExpiresAfter 食物存在多少步后消失并换位置（0 = 不过期）
 */
export const SNAKE_DIFFICULTIES = {
  // 括号里是用启发式执行器实测的平均步数（3 局、上限 1200 步）
  easy: { label: "简单", obstacles: 0, accelEvery: 0, stepMs: 120, minStepMs: 120, foodExpiresAfter: 0, shrinkEvery: 0 }, // 1200+（死不了）
  normal: { label: "普通", obstacles: 8, accelEvery: 8, stepMs: 120, minStepMs: 90, foodExpiresAfter: 0, shrinkEvery: 12 }, // ≈700
  // shrinkEvery：每吃 N 个食物，可用区域从最外圈往里收一格（变成障碍）—— 真正压缩生存空间
  hard: { label: "困难", obstacles: 12, accelEvery: 5, stepMs: 110, minStepMs: 70, foodExpiresAfter: 200, shrinkEvery: 8 }, // ≈679
  extreme: { label: "极限", obstacles: 12, accelEvery: 3, stepMs: 100, minStepMs: 55, foodExpiresAfter: 120, shrinkEvery: 5 }, // ≈150
};
export const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
export const OPPOSITE = { up: "down", down: "up", left: "right", right: "left" };

/** mulberry32：小巧的可复现随机数，让无头测试可以复跑同一局。 */
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

const idx = (x, y, size) => y * size + x;

export function isObstacle(state, x, y) {
  return (state.obstacles ?? []).some((o) => o.x === x && o.y === y);
}

function obstacleKeys(state) {
  return (state.obstacles ?? []).map((o) => idx(o.x, o.y, state.size));
}

export function createSnakeState({ size = 20, seed = 1, rng, difficulty = "normal" } = {}) {
  const random = rng ?? createRng(seed);
  const level = SNAKE_DIFFICULTIES[difficulty] ?? SNAKE_DIFFICULTIES.normal;
  const y = Math.floor(size / 2);
  const state = {
    size,
    difficulty,
    difficultyRule: level,
    obstacles: [],
    foodAge: 0,
    snake: [
      { x: 4, y },
      { x: 3, y },
      { x: 2, y },
    ],
    dir: "right",
    food: null,
    score: 0,
    steps: 0,
    alive: true,
    cause: null,
    rng: random,
  };
  state.obstacles = placeObstacles(state, level.obstacles, random);
  state.food = placeFood(state, random);
  return state;
}

/** 场地收缩：每吃 shrinkEvery 个食物，把下一圈外圈变成障碍（蛇身和食物所在格跳过，避免瞬杀）。 */
export function applyShrink(state) {
  const rule = state.difficultyRule;
  if (!rule?.shrinkEvery || state.score <= 0) return 0;
  const rings = Math.floor(state.score / rule.shrinkEvery);
  const ring = rings - 1;
  if (ring < 0 || ring * 2 >= state.size - 2) return 0;
  const body = new Set(state.snake.map((c) => idx(c.x, c.y, state.size)));
  const foodKey = state.food ? idx(state.food.x, state.food.y, state.size) : -1;
  const existing = new Set(obstacleKeys(state));
  let added = 0;
  const limit = state.size - ring;
  for (let i = ring; i < limit; i++) {
    for (const [x, y] of [
      [i, ring],
      [i, state.size - 1 - ring],
      [ring, i],
      [state.size - 1 - ring, i],
    ]) {
      const k = idx(x, y, state.size);
      if (body.has(k) || k === foodKey || existing.has(k)) continue;
      state.obstacles.push({ x, y });
      existing.add(k);
      added++;
    }
  }
  return added;
}

/** 随机撒障碍物：避开出生点那一行、蛇身和食物（保证开局有活路）。 */
export function placeObstacles(state, count, rng = state.rng) {
  if (count <= 0) return [];
  const blocked = new Set(state.snake.map((s) => idx(s.x, s.y, state.size)));
  const safeY = Math.floor(state.size / 2);
  const free = [];
  for (let y = 0; y < state.size; y++) {
    for (let x = 0; x < state.size; x++) {
      if (y === safeY && x <= 8) continue; // 出生区域留空
      if (blocked.has(idx(x, y, state.size))) continue;
      free.push({ x, y });
    }
  }
  const out = [];
  for (let i = 0; i < count && free.length > 0; i++) {
    const pick = Math.floor(rng() * free.length);
    out.push(free.splice(pick, 1)[0]);
  }
  return out;
}

/** 把带 rng 的内部状态变成可 JSON 序列化的快照（发给服务端 / 存记录用）。 */
export function snakeSnapshot(state) {
  return {
    size: state.size,
    difficulty: state.difficulty ?? "normal",
    difficultyRule: state.difficultyRule ?? null,
    obstacles: (state.obstacles ?? []).map((o) => ({ x: o.x, y: o.y })),
    foodAge: state.foodAge ?? 0,
    snake: state.snake.map((s) => ({ x: s.x, y: s.y })),
    dir: state.dir,
    food: state.food ? { x: state.food.x, y: state.food.y } : null,
    score: state.score,
    steps: state.steps,
    alive: state.alive,
    cause: state.cause,
  };
}

/** 从快照恢复出可继续演算的状态（NPC 在页面侧要用）。 */
export function snakeFromSnapshot(snap, rng = createRng(1)) {
  return {
    ...snap,
    snake: snap.snake.map((s) => ({ x: s.x, y: s.y })),
    food: snap.food ? { x: snap.food.x, y: snap.food.y } : null,
    rng,
  };
}

export function placeFood(state, rng = state.rng) {
  const occupied = new Set(state.snake.map((s) => idx(s.x, s.y, state.size)));
  for (const k of obstacleKeys(state)) occupied.add(k);
  const free = [];
  for (let y = 0; y < state.size; y++) {
    for (let x = 0; x < state.size; x++) {
      if (!occupied.has(idx(x, y, state.size))) free.push({ x, y });
    }
  }
  if (free.length === 0) return null;
  return free[Math.floor(rng() * free.length)];
}

/** 除"不能掉头"外不做任何过滤：撞墙、咬自己都是模型/玩家要自己判断的合法选择。 */
export function snakeLegalActions(state) {
  const forbidden = OPPOSITE[state.dir];
  return ACTIONS.filter((a) => a !== forbidden);
}

/** 返回死亡原因（"wall" / "self"）或 null。会把"尾巴让位"算进去。 */
export function wouldDie(state, action, body = state.snake) {
  const d = DIRS[action];
  if (!d) return "invalid";
  const head = body[0];
  const nx = head.x + d.x;
  const ny = head.y + d.y;
  if (nx < 0 || ny < 0 || nx >= state.size || ny >= state.size) return "wall";
  if (isObstacle(state, nx, ny)) return "obstacle";
  const eats = state.food && state.food.x === nx && state.food.y === ny;
  const blocked = new Set(body.map((s) => idx(s.x, s.y, state.size)));
  if (!eats) {
    const tail = body[body.length - 1];
    blocked.delete(idx(tail.x, tail.y, state.size));
  }
  return blocked.has(idx(nx, ny, state.size)) ? "self" : null;
}

/** 推进一步（就地修改）。返回本步事件。 */
export function snakeStep(state, action) {
  if (!state.alive) return { ate: false, died: false, cause: state.cause, moved: false };
  const dir = snakeLegalActions(state).includes(action) ? action : state.dir;
  state.dir = dir;
  const cause = wouldDie(state, dir);
  state.steps++;
  if (cause) {
    state.alive = false;
    state.cause = cause;
    return { ate: false, died: true, cause, moved: false };
  }
  const d = DIRS[dir];
  const head = state.snake[0];
  const nx = head.x + d.x;
  const ny = head.y + d.y;
  const eats = !!(state.food && state.food.x === nx && state.food.y === ny);
  state.snake.unshift({ x: nx, y: ny });
  if (eats) {
    state.score++;
    applyShrink(state); // 难度：吃够一定数量就收缩场地
    state.food = placeFood(state);
    state.foodAge = 0;
  } else {
    state.snake.pop();
    // 食物过期：太久没吃到就换位置（逼迫它别磨蹭）
    const rule = state.difficultyRule;
    state.foodAge = (state.foodAge ?? 0) + 1;
    if (rule?.foodExpiresAfter > 0 && state.food && state.foodAge > rule.foodExpiresAfter) {
      state.food = placeFood(state);
      state.foodAge = 0;
    }
  }
  if (!state.food) {
    state.alive = false;
    state.cause = "win";
  }
  return { ate: eats, died: false, cause: null, moved: true };
}

/** 蛇头到 target 的最短步数（-1 = 到不了）。body 上除起点和 target 外都算障碍。 */
export function gridDistance(state, from, target, body = state.snake) {
  if (!target) return -1;
  const { size } = state;
  const blocked = new Uint8Array(size * size);
  for (const s of body) blocked[idx(s.x, s.y, size)] = 1;
  for (const k of obstacleKeys(state)) blocked[k] = 1;
  blocked[idx(from.x, from.y, size)] = 0;
  blocked[idx(target.x, target.y, size)] = 0;
  const dist = new Int16Array(size * size).fill(-1);
  const queue = [from];
  dist[idx(from.x, from.y, size)] = 0;
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    const dcur = dist[idx(cur.x, cur.y, size)];
    if (cur.x === target.x && cur.y === target.y) return dcur;
    for (const a of ACTIONS) {
      const d = DIRS[a];
      const nx = cur.x + d.x;
      const ny = cur.y + d.y;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const k = idx(nx, ny, size);
      if (dist[k] !== -1 || blocked[k]) continue;
      dist[k] = dcur + 1;
      queue.push({ x: nx, y: ny });
    }
  }
  return -1;
}

/** 从 from 出发能到达的空格数（含终点格本身不算），衡量"还有多少活路"。 */
/** Upper bound on a snake grid's side, so a malformed request cannot allocate unbounded. */
export const MAX_GRID_SIZE = 512;

export function gridFloodFill(state, from, body = state.snake) {
  const { size } = state;
  // A snapshot without a usable `size` used to index NaN and never block a cell,
  // so the queue grew until the process ran out of memory. Nothing downstream can
  // answer without a grid, so say so instead of allocating.
  if (!Number.isInteger(size) || size <= 0 || size > MAX_GRID_SIZE) {
    throw new TypeError(`snake state needs an integer size in 1..${MAX_GRID_SIZE}, got ${String(size)}`);
  }
  const blocked = new Uint8Array(size * size);
  for (const s of body) blocked[idx(s.x, s.y, size)] = 1;
  for (const k of obstacleKeys(state)) blocked[k] = 1;
  blocked[idx(from.x, from.y, size)] = 0;
  const seen = new Uint8Array(size * size);
  const queue = [from];
  seen[idx(from.x, from.y, size)] = 1;
  let count = 0;
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    count++;
    for (const a of ACTIONS) {
      const d = DIRS[a];
      const nx = cur.x + d.x;
      const ny = cur.y + d.y;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const k = idx(nx, ny, size);
      if (seen[k] || blocked[k]) continue;
      seen[k] = 1;
      queue.push({ x: nx, y: ny });
    }
  }
  return count;
}

/** 对每个合法走法做一次一步推演，得到"走下去会怎样"的事实。 */
export function snakeMoveFacts(state, action) {
  const cause = wouldDie(state, action);
  if (cause) {
    return { action, dies: cause, eats: false, distAfter: null, spaceAfter: 0, tailDistanceAfter: null };
  }
  const d = DIRS[action];
  const head = state.snake[0];
  const nx = head.x + d.x;
  const ny = head.y + d.y;
  const eats = !!(state.food && state.food.x === nx && state.food.y === ny);
  const body = state.snake.map((s) => ({ x: s.x, y: s.y }));
  body.unshift({ x: nx, y: ny });
  if (!eats) body.pop();
  const tail = body[body.length - 1];
  return {
    action,
    dies: null,
    eats,
    distAfter: gridDistance(state, { x: nx, y: ny }, state.food, body),
    spaceAfter: gridFloodFill(state, { x: nx, y: ny }, body),
    tailDistanceAfter: gridDistance(state, { x: nx, y: ny }, tail, body),
  };
}

export function snakeFacts(state) {
  const head = state.snake[0];
  const tail = state.snake[state.snake.length - 1];
  const distToFood = gridDistance(state, head, state.food);
  return {
    length: state.snake.length,
    head,
    distToFood,
    freeSpace: gridFloodFill(state, head),
    tailDistance: gridDistance(state, head, tail),
    moves: snakeLegalActions(state).map((a) => snakeMoveFacts(state, a)),
  };
}

/** 交给 Laya 的状态：7x7 局部视野 + 若干事实，保持 token 预算很小。 */
export function snakeLayaState(state, { window = 7 } = {}) {
  const facts = snakeFacts(state);
  const head = state.snake[0];
  const marks = new Map(state.snake.map((s, i) => [idx(s.x, s.y, state.size), i === 0 ? "H" : "o"]));
  for (const o of state.obstacles ?? []) marks.set(idx(o.x, o.y, state.size), "#"); // 障碍物 = 墙
  if (state.food) marks.set(idx(state.food.x, state.food.y, state.size), "F");
  const r = Math.floor(window / 2);
  const view = [];
  for (let dy = -r; dy <= r; dy++) {
    let row = "";
    for (let dx = -r; dx <= r; dx++) {
      const x = head.x + dx;
      const y = head.y + dy;
      if (x < 0 || y < 0 || x >= state.size || y >= state.size) row += "#";
      else row += marks.get(idx(x, y, state.size)) ?? ".";
    }
    view.push(row);
  }
  return {
    grid: `${state.size}x${state.size}`,
    view,
    heading: state.dir,
    length: facts.length,
    score: state.score,
    steps: state.steps,
    food_offset: state.food ? { dx: state.food.x - head.x, dy: state.food.y - head.y } : null,
    food_distance: facts.distToFood < 0 ? "unreachable" : facts.distToFood,
    free_cells_from_head: facts.freeSpace,
    distance_to_own_tail: facts.tailDistance,
    blocked_obstacle_cells: (state.obstacles ?? []).length,
  };
}

function moveText(f, distNow) {
  if (f.dies) return `DEATH — dies at once (${f.dies === "wall" ? "hits the wall" : "bites its own body"})`;
  const parts = ["SAFE"];
  if (f.distAfter == null || f.distAfter < 0) parts.push("food unreachable from there");
  else if (distNow >= 0 && f.distAfter < distNow) parts.push(`closer to food (${f.distAfter} steps left)`);
  else if (distNow >= 0 && f.distAfter > distNow) parts.push(`farther from food (${f.distAfter} steps left)`);
  else parts.push(`food ${f.distAfter} steps away`);
  parts.push(`${f.spaceAfter} free cells reachable from there`);
  if (f.tailDistanceAfter != null) parts.push(`${f.tailDistanceAfter} steps from its own tail`);
  return parts.join(", ");
}

/** 一组候选动作各自的事实文案（选项描述）。单独导出，好让适配器只算一次事实。 */
export function snakeMoveCriteria(state, facts = snakeFacts(state)) {
  const distNow = facts.distToFood;
  const criteria = {};
  for (const f of facts.moves) criteria[f.action] = moveText(f, distNow);
  return criteria;
}

/** 问 Laya 的三个问题：走哪步、食物还够不够得着、现在有多危险。 */
export function snakeQuestions(state) {
  return {
    move: {
      type: "choice",
      instructions: "You are the snake (H). Pick the single best next move. Avoid dying and keep room to survive.",
      criteria: snakeMoveCriteria(state),
    },
    food_reachable: {
      type: "noul",
      instructions: "Can the snake still reach the food without dying?",
      criteria: { true: "the snake can still reach the food", false: "the food is walled off" },
    },
    risk: {
      type: "score",
      instructions: "How dangerous is the snake's current position?",
      criteria: ["very safe, plenty of open space", "fairly safe", "risky, space is tight", "nearly trapped"],
    },
  };
}

/**
 * 启发式基线（同时也是路由器的兜底）：先保证活着，再贪心靠近食物，并避免把自己关进小空间。
 * 确定性输出，便于复跑比较。
 */
export function snakeHeuristicAction(state, facts = snakeFacts(state)) {
  const distNow = facts.distToFood;
  const candidates = facts.moves;
  const safe = candidates.filter((c) => !c.dies);
  const pool = safe.length > 0 ? safe : candidates;
  let best = null;
  for (const c of pool) {
    let score = 0;
    const space = c.spaceAfter ?? 0;
    score += Math.min(space, 150) * 4;
    if (space < state.snake.length + 2) score -= 500;
    if (distNow >= 0 && c.distAfter != null && c.distAfter >= 0) {
      if (c.distAfter < distNow) score += 220;
      else if (c.distAfter > distNow) score -= 140;
      if (c.distAfter === 1) score += 60;
    }
    if (c.tailDistanceAfter != null && c.tailDistanceAfter >= 0) score -= c.tailDistanceAfter * 0.5;
    if (c.dies) score -= 1e9;
    if (!best || score > best.score) best = { score, action: c.action, fact: c };
  }
  return best;
}

/**
 * 一句话现状（约 60 token）：只讲"我在哪、朝哪走、四个方向各是什么、食物在哪"，
 * 适合放在 state 里，也适合直接嵌进问题里。
 */
export function snakeBriefState(state) {
  const head = state.snake[0];
  const facts = snakeFacts(state);
  const dirs = [];
  for (const action of ACTIONS) {
    const f = facts.moves.find((m) => m.action === action);
    if (!f) continue;
    dirs.push(f.dies ? `${action}=immediate death (${f.dies})` : `${action}=safe`);
  }
  const food = state.food
    ? (() => {
        const dx = state.food.x - head.x;
        const dy = state.food.y - head.y;
        const cols = `${Math.abs(dx)} column${Math.abs(dx) === 1 ? "" : "s"}`;
        const rows = `${Math.abs(dy)} row${Math.abs(dy) === 1 ? "" : "s"}`;
        return (
          `Food is ${cols} ${dx >= 0 ? "right" : "left"} and ${rows} ${dy >= 0 ? "down" : "up"} of the head` +
          (facts.distToFood < 0 ? ", but it cannot be reached." : `, ${facts.distToFood} steps away.`)
        );
      })()
    : "No food left.";
  const rule = state.difficultyRule;
  const obstacleText = state.obstacles?.length ? ` ${state.obstacles.length} blocked obstacle cells are scattered on the board (marked #); hitting one kills the snake.` : "";
  const ruleText = rule?.foodExpiresAfter > 0 ? ` Food disappears and moves if it is not eaten within ${rule.foodExpiresAfter} steps.` : "";
  return (
    `Snake game on a ${state.size}x${state.size} board. Head at column ${head.x}, row ${head.y}, moving ${state.dir}, body ${state.snake.length} cells long.${obstacleText}${ruleText} ` +
    `Possible moves: ${dirs.join(", ")}. ${food} ${facts.freeSpace} empty cells still reachable.` +
    (wouldDie(state, state.dir) ? ` Keeping the current direction ${state.dir} means dying on the next step.` : "")
  );
}

/** 现状嵌进问题里：state 仍用 7x7 视野，但问题开头先把处境讲一遍。 */
export function snakeQuestionsWithStatus(state) {
  const questions = snakeQuestions(state);
  return {
    ...questions,
    move: {
      ...questions.move,
      instructions: `Situation: ${snakeBriefState(state)} Now judge the single best next move for the snake.`,
    },
  };
}
export function snakeProseState(state) {
  const { size } = state;
  const head = state.snake[0];
  const facts = snakeFacts(state);
  const dirPhrase = {
    up: "upwards (towards row 0)",
    down: "downwards (towards larger row numbers)",
    left: "to the left (towards column 0)",
    right: "to the right (towards larger column numbers)",
  }[state.dir];

  const distances = [
    ["above you", head.y],
    ["below you", size - 1 - head.y],
    ["to your left", head.x],
    ["to your right", size - 1 - head.x],
  ];
  const parts = [];
  parts.push(
    `You are the snake in a game of Snake on a ${size} by ${size} board with solid walls on all four sides; ` +
      `columns count from 0 at the left edge and rows count from 0 at the top edge.`,
  );
  parts.push(`You are moving ${dirPhrase} and you are not allowed to reverse into your own body.`);
  parts.push(`Your head is at column ${head.x}, row ${head.y} and your body is ${state.snake.length} cells long.`);
  parts.push(
    `Free space around you: ${distances.map(([where, d]) => `${d} cell${d === 1 ? "" : "s"} ${where}`).join(", ")}.`,
  );

  const around = [];
  for (const action of ACTIONS) {
    const f = facts.moves.find((m) => m.action === action);
    if (!f) continue; // 反向走法不允许，不出现在选项里
    if (f.dies) {
      around.push(
        `${action}: DEATH, moving ${action} now kills you (${f.dies === "wall" ? "the wall is immediately there" : "your own body is immediately there"})`,
      );
    } else {
      const closer = f.distAfter != null && f.distAfter >= 0 && facts.distToFood >= 0 && f.distAfter < facts.distToFood;
      around.push(
        `${action}: safe, you would have ${f.spaceAfter} reachable empty cells` +
          (f.distAfter == null || f.distAfter < 0 ? " and the food would be unreachable from there" : ` and be ${f.distAfter} steps from the food${closer ? " (closer)" : ""}`),
      );
    }
  }
  parts.push(`What is happening in each direction — ${around.join("; ")}.`);

  if (state.food) {
    const dx = state.food.x - head.x;
    const dy = state.food.y - head.y;
    const bits = [];
    if (dx !== 0) bits.push(`${Math.abs(dx)} column${Math.abs(dx) === 1 ? "" : "s"} to the ${dx > 0 ? "right" : "left"}`);
    if (dy !== 0) bits.push(`${Math.abs(dy)} row${Math.abs(dy) === 1 ? "" : "s"} ${dy > 0 ? "down" : "up"}`);
    const where = bits.length ? bits.join(" and ") : "in your own cell";
    parts.push(
      facts.distToFood < 0
        ? `The food is ${where} of your head, but your own body blocks every path to it.`
        : `The food is ${where} of your head and the shortest way to it is ${facts.distToFood} steps.`,
    );
  } else {
    parts.push("There is no food left on the board.");
  }

  parts.push(`You can still reach ${facts.freeSpace} empty cells from your head, and your tail is ${facts.tailDistance} steps behind you.`);
  parts.push(
    wouldDie(state, state.dir)
      ? `Warning: you are currently heading straight into death — if you do not turn on this step, the game ends.`
      : `If you keep going ${state.dir}, you survive the next step.`,
  );
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** 按表示法选状态：grid（7x7 视野）/ facts（键值事实）/ prose（自然语言现状）/ brief（一句话现状） */
export function snakeStateByStyle(state, style = "prose") {
  if (style === "grid") return snakeLayaState(state);
  if (style === "brief") return snakeBriefState(state);
  if (style === "facts") {
    const head = state.snake[0];
    const facts = snakeFacts(state);
    return {
      board: `${state.size}x${state.size} grid, columns from the left, rows from the top`,
      head,
      moving: state.dir,
      body_length: state.snake.length,
      cells_to_the_wall_on_the_right: state.size - 1 - head.x,
      cells_to_the_wall_on_the_left: head.x,
      cells_to_the_wall_below: state.size - 1 - head.y,
      cells_to_the_wall_above: head.y,
      food: state.food,
      food_offset_from_head: state.food ? { dx: state.food.x - head.x, dy: state.food.y - head.y } : null,
      food_steps_away: facts.distToFood < 0 ? "unreachable" : facts.distToFood,
      reachable_empty_cells: facts.freeSpace,
    };
  }
  return snakeProseState(state);
}

/* ================= 策略决策（决策模型的正确用法） =================
 * 环境情况（state）+ 若干个语义明确的决策选项（criteria）→ 让它选一个；
 * 具体"走哪一格"由确定性代码按策略算出来。不再问它"食物在哪个方向"这类感知题。
 */

export const SNAKE_STRATEGIES = ["chase", "survive", "hug", "straight"];

/** 奖励规则：吃到食物加分，游戏结束扣分。用来"促使它去得分"。 */
export const SNAKE_REWARD = { food: 10, death: -100 };

export function snakeReward(state) {
  const food = state.score * SNAKE_REWARD.food;
  const death = state.alive ? 0 : SNAKE_REWARD.death;
  const steps = state.steps || 0;
  return {
    food,
    death,
    total: food + death,
    per100Steps: steps > 0 ? Math.round((state.score / steps) * 1000) / 10 : 0,
  };
}

/** 环境报告：把能观察到的都讲清楚（约 130 token），作为 state 交给模型。 */
export function snakeEnvironmentCard(state) {
  const { size } = state;
  const head = state.snake[0];
  const facts = snakeFacts(state);
  const body = state.snake;
  // 只保留决策必需的信息（短一点 = 每条序列都短一点 = 前向更快）
  const lines = [];
  lines.push(`Environment: a ${size} by ${size} grid with walls all around.`);
  lines.push(`The snake's head is at column ${head.x}, row ${head.y}, moving ${state.dir}; the body is ${body.length} cells long.`);
  if (state.food) {
    const dx = state.food.x - head.x;
    const dy = state.food.y - head.y;
    lines.push(
      `The food is ${Math.abs(dx)} columns ${dx >= 0 ? "right" : "left"} and ${Math.abs(dy)} rows ${dy >= 0 ? "down" : "up"} of the head: ` +
        (facts.distToFood < 0 ? "the body blocks every path to it." : `${facts.distToFood} steps away along the shortest safe path.`),
    );
  } else {
    lines.push("There is no food left on the grid.");
  }
  if (state.obstacles?.length) lines.push(`${state.obstacles.length} obstacle cells block the board (marked #).`);
  lines.push(`${facts.freeSpace} empty cells are still reachable from the head.`);
  lines.push(
    `Reward: +${SNAKE_REWARD.food} per food, ${SNAKE_REWARD.death} when the game ends. Current score: ${state.score} food (${state.score * SNAKE_REWARD.food} reward points) in ${state.steps} steps.`,
  );
  const dying = wouldDie(state, state.dir);
  lines.push(
    dying
      ? `Danger: continuing ${state.dir} now would kill the snake (${dying === "wall" ? "wall immediately there" : "own body immediately there"}).`
      : `Continuing ${state.dir} now is survivable.`,
  );
  return lines.join(" ");
}

/** 四个策略选项在这里分别意味着什么（描述随局面变化，模型据此判断该选哪个）。 */
export function snakeStrategyCriteria(state) {
  const facts = snakeFacts(state);
  const head = state.snake[0];
  const foodState = !state.food
    ? "there is no food left"
    : facts.distToFood < 0
      ? "the food is currently unreachable"
      : `the food is ${facts.distToFood} steps away`;
  const dying = wouldDie(state, state.dir);
  return {
    chase: `go for the food: the only strategy that earns reward (+${SNAKE_REWARD.food} per food) — ${foodState}`,
    survive: `play it safe: earns no reward, but avoids the ${SNAKE_REWARD.death} game-over penalty (${facts.freeSpace} cells reachable from the head)`,
    hug: `stay close to the body: earns no reward, keeps an escape route (the tail is ${facts.tailDistance} steps away)`,
    straight: `keep the current direction (${state.dir}): earns no reward${dying ? `, and it ends the game immediately (${SNAKE_REWARD.death})` : ""}`,
  };
}

/** 奖励问题：每个策略单独问一次"跟着它走能拿到多少奖励"（score 类型，0=没有奖励 … 3=最有机会拿奖励）。 */
export function snakeRewardQuestions(state) {
  const meanings = snakeStrategyCriteria(state);
  const criteria = [
    "no reward at all, purely defensive",
    "a small chance of earning reward",
    "likely to earn reward",
    "the best chance of earning reward",
  ];
  const out = {};
  for (const strategy of SNAKE_STRATEGIES) {
    out[`reward_${strategy}`] = {
      type: "score",
      instructions: `The "${strategy}" strategy means: ${meanings[strategy]}. How much reward would that lead to now?`,
      criteria,
    };
  }
  return out;
}

/** 把策略翻译成具体动作（确定性、可复核）。 */
export function snakeStrategyAction(state, strategy, facts = snakeFacts(state)) {
  const safe = facts.moves.filter((m) => !m.dies);
  const pool = safe.length > 0 ? safe : facts.moves;
  const mostSpace = (candidates) => candidates.reduce((a, b) => ((b.spaceAfter ?? 0) > (a.spaceAfter ?? 0) ? b : a));
  if (strategy === "chase") {
    // 安全追赶：只在"能缩短距离且不会把自己关起来"的走法里挑，活路最多的优先
    const closer = pool.filter(
      (m) => m.distAfter != null && m.distAfter >= 0 && (facts.distToFood < 0 || m.distAfter < facts.distToFood),
    );
    const roomy = closer.filter((m) => (m.spaceAfter ?? 0) >= state.snake.length + 2);
    const candidates = roomy.length > 0 ? roomy : closer;
    if (candidates.length > 0) return mostSpace(candidates).action;
    return mostSpace(pool).action; // 追不到（或追赶会自陷）就转成保活
  }
  if (strategy === "hug") {
    const withTail = pool.filter((m) => m.tailDistanceAfter != null && m.tailDistanceAfter >= 0);
    if (withTail.length > 0) return withTail.reduce((a, b) => (b.tailDistanceAfter < a.tailDistanceAfter ? b : a)).action;
    return mostSpace(pool).action;
  }
  if (strategy === "straight") {
    const straight = pool.find((m) => m.action === state.dir);
    return (straight ?? mostSpace(pool)).action;
  }
  return mostSpace(pool).action; // survive（默认/兜底）
}

/** 每个策略在当前局面会走哪一步（给页面展示"模型选了什么、别的策略会怎么走"）。 */
export function snakeStrategyPreview(state) {
  const facts = snakeFacts(state);
  return Object.fromEntries(SNAKE_STRATEGIES.map((s) => [s, snakeStrategyAction(state, s, facts)]));
}
