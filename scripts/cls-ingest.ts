// 财联社公开电报落库（cls_telegraph 表）：增量最新页 + 按游标回补。
//
// 为什么要有这个文件：此前电报现拉现用不落库，隔夜突发复核这类「按时间窗回查原文」
// 的链路只能每次重拉接口——接口能回溯多深不由我们定，而且失败就什么都没有。
// 落库后窗口查询走本地表，接口只负责把新电报喂进来。
//
// 只用公开电报接口（src/lib/desk/cls-telegraph.ts 的 fetchClsTelegraphPage），不碰 VIP 付费内容。
// 去重靠电报 id 主键 + INSERT OR IGNORE，重复跑不会翻倍。
//
// 用法：
//   node --experimental-strip-types scripts/cls-ingest.ts
//     # 增量：拉最新一页（rn=50）落库（cron 每 5 分钟跑这个模式）
//   node --experimental-strip-types scripts/cls-ingest.ts --backfill-from 2026-10-19
//   node --experimental-strip-types scripts/cls-ingest.ts --backfill-from "2026-10-19 00:00"
//     # 回补：从现在起按 last_time 游标往前翻页，直到翻到起始时刻之前为止。
//     # 接口能回溯多深以实测为准：跑完打印实际落库的最早一条时间，不许假装补齐。
//
// 失败如实抛错并以非零码退出，绝不拿空结果冒充成功。

import { PrismaClient } from "@prisma/client";
import {
  fetchClsTelegraphPage,
  clsShanghaiShowTime,
  clsFullTitleOf,
  type ClsRollItem,
} from "../src/lib/desk/cls-telegraph.ts";

const PAGE_RN = 50;
const MAX_BACKFILL_PAGES = 800; // 安全阀：rn=50 时约 4 万条，远超任何回补窗口
const PAGE_DELAY_MS = 250;

const db = new PrismaClient();

function nowShanghai(): string {
  return clsShanghaiShowTime(Math.floor(Date.now() / 1000));
}

async function ensureTable(): Promise<void> {
  await db.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS cls_telegraph (
       id TEXT PRIMARY KEY,
       ctime INTEGER NOT NULL,
       sh_time TEXT NOT NULL,
       title TEXT NOT NULL DEFAULT '',
       content TEXT NOT NULL DEFAULT '',
       subjects TEXT NOT NULL DEFAULT '[]',
       stock_list TEXT NOT NULL DEFAULT '[]',
       created_at TEXT NOT NULL DEFAULT ''
     )`
  );
  await db.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_cls_telegraph_ctime ON cls_telegraph(ctime)`
  );
  await db.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_cls_telegraph_sh_time ON cls_telegraph(sh_time)`
  );
}

/** 一条电报落库；返回 1=新插入，0=id 已存在被忽略。 */
async function insertItem(it: ClsRollItem, createdAt: string): Promise<number> {
  const id = String(it.id ?? "").trim();
  const ctime = Number(it.ctime);
  if (!id || !Number.isFinite(ctime) || ctime <= 0) return 0;
  const subjects = JSON.stringify(
    (it.subjects ?? []).map((s) => String(s?.subject_name ?? "")).filter(Boolean)
  );
  const stockList = JSON.stringify(it.stock_list ?? []);
  const content = String(it.content ?? it.brief ?? "");
  const title = clsFullTitleOf(it);
  return db.$executeRawUnsafe(
    `INSERT OR IGNORE INTO cls_telegraph (id, ctime, sh_time, title, content, subjects, stock_list, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    ctime,
    clsShanghaiShowTime(ctime),
    title,
    content,
    subjects,
    stockList,
    createdAt
  );
}

interface IngestStats {
  fetched: number;
  inserted: number;
  ignored: number;
  minCtime: number; // 本轮见到的最早 ctime（0 = 一条都没拉到）
}

async function ingestPage(items: ClsRollItem[], createdAt: string): Promise<IngestStats> {
  const st: IngestStats = { fetched: items.length, inserted: 0, ignored: 0, minCtime: 0 };
  for (const it of items) {
    const ctime = Number(it.ctime);
    if (Number.isFinite(ctime) && ctime > 0 && (st.minCtime === 0 || ctime < st.minCtime)) {
      st.minCtime = ctime;
    }
    const n = await insertItem(it, createdAt);
    if (n > 0) st.inserted++;
    else st.ignored++;
  }
  return st;
}

async function tableRange(): Promise<{ count: number; earliest: string; latest: string }> {
  const rows = await db.$queryRawUnsafe<{ c: number; mn: string | null; mx: string | null }[]>(
    `SELECT COUNT(*) AS c, MIN(sh_time) AS mn, MAX(sh_time) AS mx FROM cls_telegraph`
  );
  const r = rows[0];
  return { count: Number(r?.c ?? 0), earliest: r?.mn ?? "", latest: r?.mx ?? "" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  await ensureTable();
  const createdAt = nowShanghai();
  const bfIdx = process.argv.indexOf("--backfill-from");

  if (bfIdx < 0) {
    // ---- 增量模式：最新一页 ----
    const items = await fetchClsTelegraphPage(Math.floor(Date.now() / 1000), PAGE_RN);
    const st = await ingestPage(items, createdAt);
    const range = await tableRange();
    console.log(
      `cls-ingest 增量完成：拉到 ${st.fetched} 条，新入库 ${st.inserted} 条，已存在跳过 ${st.ignored} 条；` +
        `库内共 ${range.count} 条，范围 ${range.earliest || "（空）"} ~ ${range.latest || "（空）"}`
    );
    return;
  }

  // ---- 回补模式：游标往前翻页 ----
  const raw = process.argv[bfIdx + 1];
  if (!raw) {
    console.error("用法：--backfill-from 2026-10-19 或 --backfill-from \"2026-10-19 00:00\"（按上海时间）");
    process.exit(2);
  }
  const norm = raw.length <= 10 ? `${raw} 00:00:00` : raw.length === 16 ? `${raw}:00` : raw;
  const startEpoch = Date.parse(`${norm.replace(" ", "T")}+08:00`) / 1000;
  if (!Number.isFinite(startEpoch)) {
    console.error(`起始时间解析失败：${raw}`);
    process.exit(2);
  }
  console.log(`cls-ingest 回补：目标起始 ${norm}（上海），epoch=${startEpoch}`);

  let cursor = Math.floor(Date.now() / 1000);
  let totalFetched = 0;
  let totalInserted = 0;
  let totalIgnored = 0;
  let reachedStart = false;
  for (let page = 0; page < MAX_BACKFILL_PAGES; page++) {
    const items = await fetchClsTelegraphPage(cursor, PAGE_RN);
    if (!items.length) {
      console.log(`第 ${page + 1} 页返回空，回补停止（接口没有更早的数据了）。`);
      break;
    }
    const st = await ingestPage(items, createdAt);
    totalFetched += st.fetched;
    totalInserted += st.inserted;
    totalIgnored += st.ignored;
    if (page % 20 === 0 || st.minCtime <= startEpoch) {
      console.log(
        `  第 ${page + 1} 页：本页最早 ${st.minCtime ? clsShanghaiShowTime(st.minCtime) : "?"}，累计新入库 ${totalInserted}`
      );
    }
    if (st.minCtime > 0 && st.minCtime <= startEpoch) {
      reachedStart = true;
      break;
    }
    if (st.minCtime <= 0 || st.minCtime - 1 >= cursor) {
      console.log(`第 ${page + 1} 页游标未推进（minCtime=${st.minCtime}，cursor=${cursor}），回补停止。`);
      break;
    }
    cursor = st.minCtime - 1;
    await sleep(PAGE_DELAY_MS);
  }
  const range = await tableRange();
  console.log(
    `cls-ingest 回补结束：共拉 ${totalFetched} 条，新入库 ${totalInserted} 条，已存在跳过 ${totalIgnored} 条；` +
      `是否翻到目标起始之前：${reachedStart ? "是" : "否（接口回溯深度到此为止）"}；` +
      `库内共 ${range.count} 条，实际范围 ${range.earliest || "（空）"} ~ ${range.latest || "（空）"}`
  );
}

main()
  .catch((e) => {
    console.error(`cls-ingest 失败：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
