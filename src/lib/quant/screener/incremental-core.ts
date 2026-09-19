// P3 第三阶段 增量扫描内核（纯函数，不碰数据库、不 import next/*）
//
// 为什么单独一份纯模块：增量逻辑的正确性（游标只在成功后推进、同一批数据不重复落库、
// 失败后从上次位置继续）必须能在无网络、无真实行情的情况下被完整验证；
// 数据源不可控，用真实行情去撞「恰好重复」的分支等于把验收交给运气（REAL_DATA_ONLY：
// 不伪造场景，也不靠伪造场景下结论）。真实链路的对拍见 tests/quant/p2-scan-loop.test.ts。
//
// 与第二阶段的关系：只做「少写、不重复写」，不改任何判定公式与映射规则。
// 全量扫描（先删后插）仍然是手动点击与首次扫描的口径；增量只改变「写哪些行」。

/**
 * 游标键集合上限（每 kind × 交易日一条游标）。
 * 取值依据：单日雷达候选数十条、事件候选 = 上游滚动窗口条数量级，3000 足够容纳整天数据；
 * 达到上限时按插入顺序丢弃最早的键 —— 丢的只是「跳过优化」，下次扫描会走库内键比对识别为 unchanged，
 * 不会漏数据（见 advanceCursor 注释）。
 */
export const MAX_CURSOR_KEYS = 3000;

/** 扫描口径的可读文案（API / 页面 / task_run 备注共用，避免同一状态多处各写一遍） */
export const MODE_TEXT: Record<"full" | "incremental", string> = {
  full: "全量（当日先删后插重刷）",
  incremental: "增量（只写新增与内容变化的行）",
};

/** task_run.basis / scan_cursor.basis 里写口径用的固定前缀：文案与解析同处一份实现，页面不各自猜 */
export function modeBasisLabel(mode: keyof typeof MODE_TEXT): string {
  return `口径 ${MODE_TEXT[mode]}`;
}

/** 从已落库的 basis 文本里读回口径（不解析出关键词就返回空串，让页面显示「未记录」而不是猜） */
export function modeFromBasis(text: string): keyof typeof MODE_TEXT | "" {
  const hit = (Object.keys(MODE_TEXT) as (keyof typeof MODE_TEXT)[]).find((m) => text.includes(MODE_TEXT[m]));
  return hit ?? "";
}

/** 快讯指纹：上游（东财 7x24 / 新浪直播）只给 HH:MM + 标题，没有 id，故用内容指纹当自然键 */
export function newsFingerprint(time: string, title: string): string {
  return `${String(time ?? "").trim()}|${normalizeTitle(title)}`;
}

function normalizeTitle(t: string): string {
  return String(t ?? "").replace(/\s+/g, " ").trim();
}

/** 雷达发现的稳定自然键：同一天里「同一类信号 + 同一标的/事件 + 同一标题」就是同一条，不得插两行 */
export function radarNaturalKey(item: { kind: string; title: string; evidence?: Record<string, unknown> | null }): string {
  const ev = (item.evidence ?? {}) as Record<string, unknown>;
  let idPart = String(ev.code ?? ev.eventKey ?? ev.level ?? "");
  let title = normalizeTitle(item.title);
  if (!idPart) {
    // 没有标的/等级可依赖的信号（例如「炸板率 45%」「涨跌家数比 0.42」）：标题本身就带着实时数值。
    // 若直接把数值写进键，数值一变就成「另一条信号」→ 每次扫描插一行、把上一行判成已消失，
    // 当日列表被同一信号的多个版本刷屏。这里把数字抹成同一占位符，让它保持同一条并走内容更新，
    // 首次出现时刻（createdAt）因此不会被后续扫描覆盖。信号种类仍由标题文字区分，不合并不同信号。
    title = title.replace(/\d+(?:\.\d+)?/g, "#");
  }
  return `${item.kind}|${idPart}|${title}`;
}

/** 键超长时压成定长指纹：DB 里键列不宜无限增长（回填与写入必须同一实现，故导出） */
export function boundedKey(key: string): string {
  return key.length <= 200 ? key : `${key.slice(0, 150)}#${hash12(key)}`;
}

/** 事件行的自然键：快讯本身不变，故键不含资金验证结果（资金验证变化走 contentHash） */
export function eventNaturalKey(item: { time: string; title: string }): string {
  return boundedKey(`ev|${newsFingerprint(item.time, item.title)}`);
}

/**
 * 雷达行的「键 + 内容指纹」。
 * 指纹只覆盖 detail+evidence：标题是键的一部分（标题一变就是另一条信号），内容变化留给指纹表达。
 * 写入路径与老数据回填路径都调用本函数，保证同一行两次计算得到的指纹一致。
 */
export function radarKeyOf(item: { kind: string; title: string; detail: string; evidence?: Record<string, unknown> | null }): { dedupeKey: string; contentHash: string } {
  const evidence = item.evidence ?? {};
  return { dedupeKey: boundedKey(radarNaturalKey(item)), contentHash: contentHash({ detail: item.detail, evidence }) };
}

/** 事件行参与指纹的业务字段（time/title 属于自然键部分，不重复计入内容指纹；asOf 是分区列，同理） */
export interface EventHashFields {
  level: string;
  category: string;
  mappedSectors: string[];
  relatedStocks: string[];
  fundCheck: Record<string, unknown>;
  stage: string;
  source: string;
}

/**
 * 事件行的「键 + 内容指纹」。字段逐一列出而不是整体 spread：
 * 落库读回时 JSON 列会被反序列化，字段集合固定下来才能证明「回填的老行」与「新写的行」用同一口径算指纹。
 */
export function eventKeyOf(item: { time: string; title: string } & EventHashFields): { dedupeKey: string; contentHash: string } {
  return {
    dedupeKey: eventNaturalKey(item),
    contentHash: contentHash({
      time: item.time,
      title: item.title,
      level: item.level,
      category: item.category,
      mappedSectors: item.mappedSectors ?? [],
      relatedStocks: item.relatedStocks ?? [],
      fundCheck: item.fundCheck ?? {},
      stage: item.stage,
      source: item.source,
    }),
  };
}

/** 内容指纹：用于判断「同一条是否发生了变化」。键序固定，避免同一内容因序列化顺序不同被误判为变化 */
export function contentHash(payload: unknown): string {
  return hash12(canonicalJson(payload));
}

/** 一批候选的整体指纹：作为「数据基准」水位线写进游标，供状态接口如实回答「上次扫到哪一批数据」 */
export function setFingerprint<T>(items: T[], hashOf: (item: T) => string): string {
  return contentHash(items.map(hashOf).sort());
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function hash12(s: string): string {
  // 纯字符串散列（FNV-1a 64 位近似，用 BigInt 保证跨平台一致），不引依赖。
  // 注意：这里必须用 BigInt("0x…") 而不是 0x…n 字面量 —— 项目 tsconfig 的 target 低于 ES2020，
  // 大整数字面量是编译错误（TS2737），而构造函数写法不受影响，散列结果与字面量写法完全一致。
  const offset = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  const one = BigInt(1);
  const mask = (one << BigInt(64)) - one; // 64 位溢出截断，保持和原生 64 位回绕同构
  let h = offset;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ BigInt(s.charCodeAt(i))) * prime & mask;
  }
  return h.toString(16).padStart(16, "0").slice(0, 12);
}

export interface ExistingRowLite {
  id: string;
  dedupeKey: string;
  contentHash: string;
  /** 库内状态：live / superseded。缺省（历史行尚未回填）按 live 处理，不得把老数据当成「已消失」 */
  state?: string;
}

export interface RadarPlannedItem {
  dedupeKey: string;
  contentHash: string;
  kind: string;
  title: string;
  detail: string;
  evidence: Record<string, unknown>;
}

export interface RadarDelta {
  /** 库里没有的键 → 新插 */
  insert: RadarPlannedItem[];
  /** 键已存在但内容变了 → 原地更新（保留 id 与 createdAt，便于「什么时候第一次出现」不被覆盖） */
  update: (RadarPlannedItem & { id: string })[];
  /** 键与内容都一样 → 什么都不做（这就是「同一批数据重复扫描不产生重复」的实现点） */
  unchanged: number;
  /** 库里有、本次算不出来的行 → 不再冒充当日结论，标记为 superseded（不物理删除，历史留给第四阶段复盘） */
  supersedeIds: string[];
  /** 本次算出的全部键数，供接口如实回报候选量 */
  candidates: number;
}

/**
 * 规划一次雷达增量写入。
 * 输入是「本次全量计算出来的候选」+「库里当日已有的 live 行」，输出是四种处置。
 * 注意：候选集合仍由原有公式全量产出（不减少任何判定），增量只体现在「不重写没变的行」。
 */
export function planRadarDelta(
  candidates: { kind: string; title: string; detail: string; evidence?: Record<string, unknown> }[],
  existing: ExistingRowLite[],
): RadarDelta {
  const byKey = new Map<string, ExistingRowLite>();
  for (const r of existing) {
    if (!r.dedupeKey) continue;
    const prev = byKey.get(r.dedupeKey);
    // 同键多行（历史上没有唯一键约束时留下的重复行）：优先认 live 行，避免把已消失的行当成「这条还在」
    if (!prev || (prev.state === "superseded" && r.state !== "superseded")) byKey.set(r.dedupeKey, r);
  }

  const insert: RadarPlannedItem[] = [];
  const update: (RadarPlannedItem & { id: string })[] = [];
  const seenKeys = new Set<string>();
  let unchanged = 0;

  for (const c of candidates) {
    const evidence = (c.evidence ?? {}) as Record<string, unknown>;
    const planned: RadarPlannedItem = {
      ...radarKeyOf(c),
      kind: c.kind,
      title: c.title,
      detail: c.detail,
      evidence,
    };
    if (seenKeys.has(planned.dedupeKey)) {
      // 同一次扫描里就撞键（例如同板块同标题被两条链路各产出一次）：不重复插，按内容变化决定是否更新
      const prevDup = insert.find((x) => x.dedupeKey === planned.dedupeKey);
      const dupUpdate = update.find((x) => x.dedupeKey === planned.dedupeKey);
      const target = dupUpdate ?? prevDup;
      if (target && target.contentHash !== planned.contentHash) {
        target.contentHash = planned.contentHash;
        target.detail = planned.detail;
        target.evidence = planned.evidence;
      }
      continue;
    }
    seenKeys.add(planned.dedupeKey);
    const hit = byKey.get(planned.dedupeKey);
    if (!hit) {
      insert.push(planned);
    } else if (hit.contentHash !== planned.contentHash) {
      update.push({ ...planned, id: hit.id });
    } else if (hit.state && hit.state !== "live") {
      // 内容完全一致但此前被标记为已消失 —— 本次又算出来了，说明信号回来了，原地复活而不是再插一行
      update.push({ ...planned, id: hit.id });
    } else {
      unchanged++;
    }
  }

  // 库里有、本次算不出来：只针对当前 live 行（已标记过的不重复计数）
  const supersedeIds = existing
    .filter((r) => r.dedupeKey && !seenKeys.has(r.dedupeKey) && (!r.state || r.state === "live"))
    .map((r) => r.id);
  return { insert, update, unchanged, supersedeIds, candidates: candidates.length };
}

export interface EventPlannedItem {
  dedupeKey: string;
  contentHash: string;
  time: string;
  title: string;
  fields: EventHashFields;
}

export interface EventDelta {
  insert: EventPlannedItem[];
  update: (EventPlannedItem & { id: string })[];
  unchanged: number;
  /** 已入库但本次上游窗口里没出现（窗口是滚动最近 N 条）→ 保留，不算变化 */
  kept: number;
  candidates: number;
}

/**
 * 规划一次事件增量写入。
 * 与雷达的关键差别：快讯窗口是滚动的「最近 N 条」，老消息滑出窗口不代表它错了，
 * 因此这里**不做 supersede**，只处理新增与内容变化（把滑出窗口当变化会把已入库事件抹掉，属于丢历史）。
 * 键与指纹都走 eventKeyOf —— 与「老行回填」同一实现，保证同一行不管从哪条路径算，指纹都对得上。
 */
export function planEventDelta(
  candidates: ({ time: string; title: string } & EventHashFields)[],
  existing: ExistingRowLite[],
): EventDelta {
  const byKey = new Map<string, ExistingRowLite>();
  for (const r of existing) if (r.dedupeKey) byKey.set(r.dedupeKey, r);

  const insert: EventPlannedItem[] = [];
  const update: (EventPlannedItem & { id: string })[] = [];
  const seenKeys = new Set<string>();
  let unchanged = 0;

  for (const c of candidates) {
    const { dedupeKey: key, contentHash: ch } = eventKeyOf(c);
    if (seenKeys.has(key)) continue; // 同一批里重复推送的快讯只落一条
    seenKeys.add(key);
    const planned: EventPlannedItem = {
      dedupeKey: key,
      contentHash: ch,
      time: c.time,
      title: c.title,
      fields: {
        level: c.level,
        category: c.category,
        mappedSectors: c.mappedSectors ?? [],
        relatedStocks: c.relatedStocks ?? [],
        fundCheck: c.fundCheck ?? {},
        stage: c.stage,
        source: c.source,
      },
    };
    const hit = byKey.get(key);
    if (!hit) insert.push(planned);
    else if (hit.contentHash !== ch) update.push({ ...planned, id: hit.id });
    else unchanged++;
  }

  // 没有键的行不在此计数内：它们由回填环节（persist 在规划前统一补键）负责，不靠这里猜
  const kept = existing.filter((r) => r.dedupeKey && !seenKeys.has(r.dedupeKey)).length;
  return { insert, update, unchanged, kept, candidates: candidates.length };
}

export interface CursorLite {
  /** 上游数据位置：事件=本次成功处理到的最大时间戳；雷达=候选集合指纹 */
  watermark: string;
  /** 上次成功确认落库的键 → 内容指纹（只有写成功才并入，见 advanceCursor） */
  doneKeys: Record<string, string>;
  /** 已扫过但未命中的键（事件专用：下次直接跳过，不再重跑映射与资金验证） */
  scannedUnmatched: string[];
  updatedAt: number;
}

export interface ScanStats {
  scanned: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skippedByCursor: number;
  superseded?: number;
}

/** 没有游标（或跨到新的交易日）→ 首次，走原有全量口径 */
export function isFirstRun(cursor: CursorLite | null, tradeDate: string, cursorTradeDate: string | null): boolean {
  return !cursor || cursorTradeDate !== tradeDate || Object.keys(cursor.doneKeys ?? {}).length === 0;
}

/** 强制重跑（人工点「立即扫描」）时不让游标跳过任何数据，仍按全量候选重算 */
export function decideMode(opts: {
  force?: boolean;
  /** 调用方显式指定口径；"auto"（缺省）= 有当日游标就走增量，否则走全量 */
  mode?: "auto" | "full" | "incremental";
  cursor: CursorLite | null;
  tradeDate: string;
  cursorTradeDate: string | null;
}): "incremental" | "full" {
  if (opts.mode === "incremental") return "incremental";
  if (opts.mode === "full") return "full";
  if (opts.force) return "full"; // 人工点击：按既有全量口径重算重刷，不做跳过
  if (isFirstRun(opts.cursor, opts.tradeDate, opts.cursorTradeDate)) return "full";
  return "incremental";
}

/**
 * 能不能只凭游标就断定「本次没有任何要写的东西」。
 * 两个条件必须同时成立才敢信：
 * ① 本次候选集合的整体指纹与上次成功时逐字相同（内容一模一样，没有新增也没有变化）；
 * ② 库里当日 live 行数 = 游标记录的键数 —— 这是完整性校验。行被外部删过、或游标键被裁剪过时不满足，
 *    于是回落到「逐条比对库内键」的路径：慢一点，但绝不允许「游标说有、库里其实没有」的静默丢数据。
 * 失败路径不调用 advanceCursor，所以失败后指纹/键数对不上，下次自然回到完整比对，从上次成功位置继续。
 */
export function cursorCommitsNothing(cursor: CursorLite | null, p: { watermark: string; liveCount: number }): boolean {
  if (!cursor || !cursor.watermark || !p.watermark) return false;
  if (cursor.watermark !== p.watermark) return false;
  return Object.keys(cursor.doneKeys ?? {}).length === p.liveCount && p.liveCount > 0;
}

/**
 * 成功提交后才能调用：把本次确认落库的键并入游标。
 * 失败路径必须不调用本函数 —— 这是「失败不推进成功游标、下次从上次位置继续」的实现点。
 * 键集合按上限裁剪（保留最近优先，插入序在后），防止长期常驻把游标撑大；裁剪只丢「跳过优化」，
 * 不会丢数据：漏掉的键下次会走 unchanged 分支被幂等识别。
 */
export function advanceCursor(cursor: CursorLite | null, p: {
  watermark: string;
  doneKeys?: Record<string, string>;
  unmatchedKeys?: string[];
  now?: number;
  cap?: number;
}): CursorLite {
  const cap = p.cap ?? MAX_CURSOR_KEYS;
  const now = p.now ?? Date.now();
  const doneKeys: Record<string, string> = { ...(cursor?.doneKeys ?? {}), ...(p.doneKeys ?? {}) };
  const keys = Object.keys(doneKeys);
  if (keys.length > cap) for (const k of keys.slice(0, keys.length - cap)) delete doneKeys[k];
  const unmatched = [...new Set([...(cursor?.scannedUnmatched ?? []), ...(p.unmatchedKeys ?? [])])];
  return {
    watermark: p.watermark || cursor?.watermark || "",
    doneKeys,
    scannedUnmatched: unmatched.length > cap ? unmatched.slice(unmatched.length - cap) : unmatched,
    updatedAt: now,
  };
}

/** 未命中的快讯键：只在「映射规则表未变」的前提下才能永久跳过，故把规则表指纹带进游标键前缀 */
export function unmatchedKeyWithBasis(fingerprint: string, rulesFingerprint: string): string {
  return `${rulesFingerprint}:${fingerprint}`;
}

/** 本次数据基准指纹变了（例如映射表被编辑）→ 旧的未命中记录一律作废，重新判定 */
export function staleUnmatched(cursor: CursorLite | null, rulesFingerprint: string): string[] {
  if (!cursor) return [];
  return cursor.scannedUnmatched.filter((k) => !k.startsWith(`${rulesFingerprint}:`));
}

/**
 * 当前映射表下「已经判定为不命中」的快讯指纹集合。
 * 只有前缀等于本次映射表指纹的记录才算数：换了映射表，过去「没命中」的快讯可能命中，必须重新判定。
 */
export function freshUnmatched(cursor: CursorLite | null, rulesFingerprint: string): Set<string> {
  const prefix = `${rulesFingerprint}:`;
  return new Set((cursor?.scannedUnmatched ?? []).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
}
