// GET /api/qimen/chart?date=2026-09-21&time=14:30&city=北京 —— P7-⑨ 奇门起局（只读）
//
// 这一层只做三件事：校验入参、调排盘服务、把「算不出来」的原因如实回给页面。
// 排盘本身全在本地：服务层 qimen-service.ts 调开源库 qimendunjia-lite，适配与口径判断在纯内核 qimen-core.ts（有单测）。
//
// 为什么是 GET 而不是 POST：起局是一次纯函数计算——不写库、不建表、不触发扫描、**接口内不发任何模型请求**。
// 解盘文本由前端另走既有模型通道（ai.ts 的 aiChat → /api/ai/proxy），Key 只存在于浏览器 localStorage，本接口看不到也不碰。
// 所以这里没有「提交一份东西让服务端保存」的语义，用 GET 让口径与 /api/quant/decision 一致，也方便 curl 直接验。
//
// 为什么不设 maxDuration：全程本地算术 + 本地历法解析，毫秒级返回，没有任何上游可等，放宽超时只会掩盖真卡死。
import { NextResponse } from "next/server";
import { castChart, type CastInput } from "@/lib/qimen/qimen-service";
import { QUESTION_TYPES } from "@/lib/qimen/qimen-core";

export const dynamic = "force-dynamic";

/** 经纬度只在「确实是个有限小数」时才收，其余一律当没给（NaN/Infinity/字符串数字都不认） */
function optNum(raw: string | null): number | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * 真太阳时开关：**只认明确的关**（0/false/off/no），其余（包括没传、传了乱码）都按默认开启。
 * 为什么不直接 `!== "false"`：任务书把真太阳时校正列为默认口径，随手打错一个字就把盘起成北京时间，
 * 而两种口径在跨时辰的临界点上会得到不同的时柱——静默降级比报错更难发现。默认开启 + 只认明确关闭，
 * 关掉时 chart.calendar.true_solar_time.enabled=false 会如实标出，页面上也看得见。
 */
function trueSolarWanted(raw: string | null): boolean {
  const t = (raw ?? "").trim().toLowerCase();
  return !(t === "0" || t === "false" || t === "off" || t === "no");
}

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const date = (sp.get("date") ?? "").trim();
  const time = (sp.get("time") ?? "").trim();
  const city = (sp.get("city") ?? "").trim();
  const lon = optNum(sp.get("lon"));
  const lat = optNum(sp.get("lat"));
  const questionType = (sp.get("question_type") ?? sp.get("questionType") ?? "").trim();

  // 经纬度必须成对：只给一个的话，服务层会退化成「城市不在表里」，那句话指不到真正的问题（少给了一半）
  if ((lon === null) !== (lat === null)) {
    return NextResponse.json({
      ok: false,
      error: "lon 与 lat 要成对给：只给一个无法定位，也不会拿默认值补另一半",
    }, { status: 400 });
  }
  // 问题类型不合法不报 400：内核会退回「其他」，且返回值里带着实际用的 question_type，页面看得见用了哪一档。
  // 这里只在响应里留一句提示，免得用户以为自己的分类被采纳了。白名单本身由 normalizeQuestionType 兜底（自由文本不进 prompt）。
  const qtKnown = !questionType || QUESTION_TYPES.some((q) => q.value === questionType || q.label === questionType);

  const input: CastInput = {
    ...(date ? { date } : {}),
    ...(time ? { time } : {}),
    ...(city ? { city } : {}),
    ...(lon !== null && lat !== null ? { lon, lat } : {}),
    useTrueSolarTime: trueSolarWanted(sp.get("tst") ?? sp.get("use_true_solar_time")),
    ...(questionType ? { questionType } : {}),
  };

  try {
    const out = castChart(input);
    if (!out.ok) {
      // 算不出来＝入参的问题（时间格式、城市不在表里、年份超界）。整个接口没有上游，所以不甩 502，如实回 400。
      return NextResponse.json({ ok: false, error: out.missing, detail: out.detail ?? null }, { status: 400 });
    }
    return NextResponse.json({
      ok: true,
      chart: out.chart,
      ...(qtKnown ? {} : { note: `问题类型「${questionType}」不在白名单里，已按「其他」解盘` }),
    });
  } catch (e) {
    // 只有开源库自己抛异常才会走到这里（实测 1899/2101 是返回 {error:true}，已被内核转成 400）
    return NextResponse.json({ ok: false, error: `排盘失败：${(e as Error).message}` }, { status: 502 });
  }
}
