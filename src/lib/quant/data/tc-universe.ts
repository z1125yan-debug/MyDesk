// 腾讯批量快照兜底 — 编排层（仅服务端）
// 触发时机：em-provider 的东财 clist 全A快照抛错/空返回时，由 fetchUniverseAllA 调用本模块。
// 代码表来源：mcp provider（china-stock-mcp get_stock_a_code_name，实测 6.5s / 全量5000+，自带 5min 缓存）；
// 行情来源：qt.gtimg.cn 批量报价（60 只/请求，实测 88 字段全量），并发 6、单请求 8s 超时。
// 诚实口径：兜底快照不含 mainNet/listDate/industry；universeSource() 记录最近一次服务来源，
// 上层（sentiment/limitup/allstocks/themes）据此改写 source 文案，绝不冒充东财口径。
import { getProvider } from "./index";
import { shanghaiDate } from "@/lib/desk/session";
import { chunk, parseTcQuoteBody, splitTcQuoteText, symbolToTcCode } from "./tc-snapshot-core";
import type { AssetMeta } from "../types.ts";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const BATCH = 60; // 腾讯批量报价单次上限（保守值）
// 并发批数：5700 只 ≈ 95 请求 ÷ 12 ≈ 8 波。
// 2026-09-29 实测（36 请求 × 60 只，100% 成功）：
//   并发 6 → 2.63s（单请求均 0.40s）；并发 12 → 0.97s（0.30s）；并发 18 → 0.69s（0.29s）
// 取 12 而不是 18：对上游留余量（这是别人家的公开接口），而冷启动已从 25s 级降到十几秒、
// 配合 30~55s 的服务端 TTL，四卡刷新不用再干等。
const CONC = 12;
const REQ_TIMEOUT_MS = 8000;

// 模块实例可能因说明符不同被打包成两份（见 data/index.ts 的 globalThis 教训），标记必须放全局
const G = globalThis as typeof globalThis & { __quantUniverseSource?: "em" | "tc" | "tdx" };

export type UniverseSourceId = "em" | "tc" | "tdx";

export function universeSource(): UniverseSourceId {
  return G.__quantUniverseSource ?? "em";
}

export function setUniverseSource(s: UniverseSourceId): void {
  G.__quantUniverseSource = s;
}

async function fetchTcBatch(tcCodes: string[]): Promise<Map<string, string>> {
  const url = `https://qt.gtimg.cn/q=${tcCodes.join(",")}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return splitTcQuoteText(new TextDecoder("gbk").decode(new Uint8Array(await res.arrayBuffer())));
}

/** 全A兜底快照：代码表（MCP）× 腾讯批量行情。失败率过半即整体报错，交回调用方决定露缺姿势。 */
export async function fetchTcUniverseAllA(): Promise<AssetMeta[]> {
  const provider = await getProvider("mcp");
  const codes = await provider.listUniverse({ kind: "all" }, shanghaiDate());
  if (codes.length < 1000) throw new Error(`兜底代码表过少（${codes.length} 只，MCP 数据源可能不可用）`);
  const symbols = codes.map((c) => c.symbol);

  const out: AssetMeta[] = [];
  let batchesOk = 0;
  let batchesFail = 0;
  const groups = chunk(chunk(symbols, BATCH), CONC);
  for (const wave of groups) {
    const results = await Promise.allSettled(
      wave.map((g) => {
        const tc = g.map((s) => symbolToTcCode(s)).filter((x): x is string => x !== null);
        return tc.length ? fetchTcBatch(tc) : Promise.resolve(new Map<string, string>());
      }),
    );
    for (const r of results) {
      if (r.status !== "fulfilled") { batchesFail++; continue; }
      batchesOk++;
      for (const [tcCode, body] of r.value) {
        const m = parseTcQuoteBody(tcCode, body);
        if (m) out.push(m);
      }
    }
  }
  if (out.length < symbols.length * 0.5) {
    throw new Error(`腾讯批量快照成功率过低（代码表 ${symbols.length} / 解析成功 ${out.length} / 失败批 ${batchesFail}）`);
  }
  return out;
}
