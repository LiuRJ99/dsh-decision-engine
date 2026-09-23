/** 三个页面共用的一点点 DOM 渲染工具（记录表 / 概率条 / 时间格式化）。 */
import { ENGINE_LABELS, listRecords, recentRecords, summary } from "./records.js";

export function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDuration(ms) {
  if (ms == null) return "-";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * 画一组条形。
 *   scale   —— 数值的量程（概率用 1，0–3 的奖励分用 3）
 *   format  —— 右侧文字怎么写（默认百分比）
 *   highlight —— 要在标签后打 ★ 的名字（例如模型最终选中的那个策略）
 */
const ROW_CACHE = new WeakMap();

/**
 * 画一组条形。**原地更新**已有行（不重建 DOM，避免闪烁）；
 * 列都是定宽，数值变化不会推动布局。变化的感知交给条本身（不显示增删数字）。
 *   scale   —— 数值量程（概率用 1，0–3 的奖励分用 3）
 *   format  —— 右侧文字怎么写（默认百分比）
 *   highlight —— 打 ★ 并标绿的名字（模型最终采用的策略）
 */
export function renderProbabilities(el, probabilities, { max = 4, scale = 1, format, highlight = null } = {}) {
  if (!el) return;
  const entries = Object.entries(probabilities ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, max);
  const rows = ROW_CACHE.get(el) ?? new Map();
  const alive = new Set();

  for (const [label, value] of entries) {
    alive.add(label);
    let row = rows.get(label);
    if (!row) {
      const node = document.createElement("div");
      node.className = "bar";
      node.innerHTML =
        `<span class="bar-label"></span>` +
        `<span class="track"><span class="fill"></span></span>` +
        `<span class="mono bar-value"></span>`;
      row = {
        node,
        label: node.querySelector(".bar-label"),
        fill: node.querySelector(".fill"),
        value: node.querySelector(".bar-value"),
      };
      rows.set(label, row);
    }
    const isChosen = Boolean(highlight && label.startsWith(highlight));
    row.label.textContent = label + (isChosen ? " ★" : "");
    row.fill.classList.toggle("chosen", isChosen);
    row.fill.style.width = `${Math.max(2, Math.round((value / scale) * 100))}%`;
    row.value.textContent = format ? format(value) : `${(value * 100).toFixed(1)}%`;
  }

  for (const [label, row] of [...rows]) {
    if (!alive.has(label)) {
      row.node.remove();
      rows.delete(label);
    }
  }
  entries.forEach(([label], i) => {
    const row = rows.get(label);
    if (row && el.children[i] !== row.node) el.insertBefore(row.node, el.children[i] ?? null);
  });

  ROW_CACHE.set(el, rows);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * 对局记录列表（不是表格 —— 窄面板里表格列会被挤爆/溢出）。
 * 每条记录两行：上行「分数 + 引擎/用时/时间」，下行详情（自动换行）。
 */
export function renderRecords(el, game, { limit = 8, recent = false } = {}) {
  if (!el) return;
  const rows = recent ? recentRecords(game, limit) : listRecords(game).slice(0, limit);
  if (rows.length === 0) {
    el.innerHTML = `<div class="muted">还没有记录 —— 玩一局就会写进浏览器 localStorage（游戏就在页面里跑）。</div>`;
    return;
  }
  el.innerHTML = `<div class="records">${rows
    .map((r) => {
      const detail = r.detail ?? "";
      const meta = [ENGINE_LABELS[r.engine] ?? r.engine ?? "-", fmtDuration(r.durationMs), fmtTime(r.at)]
        .filter(Boolean)
        .join(" · ");
      return (
        `<div class="record">` +
        `<div class="record-top"><span class="record-score">${r.score ?? 0} 分</span>` +
        `<span class="record-meta">${escapeHtml(meta)}</span></div>` +
        `<div class="record-detail">${escapeHtml(String(detail))}</div>` +
        `</div>`
      );
    })
    .join("")}</div>`;
}

/** 兼容旧名字 */
export const renderRecordTable = renderRecords;

export function renderSummaryLine(el, game) {
  if (!el) return;
  const s = summary(game);
  if (s.plays === 0) {
    el.textContent = "暂无记录";
    return;
  }
  const engines = Object.entries(s.bestByEngine)
    .map(([k, v]) => `${ENGINE_LABELS[k] ?? k} ${v}`)
    .join(" · ");
  el.textContent = `共 ${s.plays} 局（人类 ${s.humanPlays} / AI ${s.machinePlays}）｜最高 ${s.best}｜${engines}`;
}

/** Laya 健康状态徽章。 */
export async function renderHealthBadge(el) {
  if (!el) return null;
  const { fetchHealth } = await import("./npc-client.js");
  const health = await fetchHealth();
  if (!health) {
    el.className = "badge bad";
    el.textContent = "服务未启动";
    return null;
  }
  const info = health.laya ?? {};
  if (info.status === "ready") {
    el.className = "badge ok";
    el.textContent = `Laya 就绪 · 加载 ${info.loadMs}ms · 已调用 ${info.stats?.calls ?? 0} 次`;
  } else if (info.status === "failed") {
    el.className = "badge bad";
    el.textContent = "Laya 加载失败（自动用本地启发式兜底）";
  } else if (info.status === "offline") {
    el.className = "badge warn";
    el.textContent = "未安装 Laya 模型：决策走本地策略（想用真模型见玩法说明）";
  } else if (info.status === "idle") {
    el.className = "badge warn";
    el.textContent = "Laya 未加载（静态模式：决策走本地兜底）";
  } else if (info.status === "loading") {
    el.className = "badge warn";
    el.textContent = "Laya 正在加载…";
  } else {
    el.className = "badge warn";
    el.textContent = `Laya 状态：${info.status}`;
  }
  return health;
}
