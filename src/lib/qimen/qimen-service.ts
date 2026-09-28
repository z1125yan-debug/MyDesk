// P7-⑨ 奇门遁甲 —— 服务层。
//
// 只有这一层碰开源库、碰时钟、碰 Date：
//  - 时钟只用项目的 shanghaiStamp()（服务端日期纪律），不接受客户端传来的「现在」；
//  - 排盘全部本地计算，不发任何外部请求；
//  - 解盘文本不在这里生成——那一层由前端走既有模型通道（ai.ts 的 aiChat → /api/ai/proxy），
//    服务端不新写第二条模型调用路径，也不读用户 Key。
import { createCalendarSnapshot, calculateFromSnapshot, getNativeHourIndex, getSolarTerms } from "qimendunjia-lite";
import { shanghaiStamp } from "@/lib/desk/session";
import {
  adaptChart, addMinutes, cityByName, coordOk, dateToWallClock, dayOfYear, equationOfTimeMinutes,
  formatWallClock, LIB_YEAR_MAX, LIB_YEAR_MIN, longitudeOffsetMinutes, normalizeQuestionType,
  parseWallClock, trueSolarOffsetMinutes, wallClockMs, wallClockToDate,
  DEFAULT_TRUE_SOLAR_TIME, TEXT_MISSING_CITY, TEXT_MISSING_INPUT, TEXT_MISSING_BIRTH, TEXT_OUT_OF_RANGE,
  NATAL_QUESTION_TYPE, type QimenMode, type QimenOutcome, type WallClock,
} from "./qimen-core";

/**
 * 晚子时口径固定用库默认的「当日起日柱」。
 * 任务书只指定了拆补法/真太阳时/中宫寄坤二宫三条，没给晚子时口径，
 * 所以不发明一个，也不做成用户可选项——写死常量并在起局口径里如实标出来。
 */
const LATE_ZI_HOUR_MODE = "same-day";

/** 任务书要求的「时家」奇门。method 之外的 type 选项在 0.1.0 里实测无差异（三元/四柱输出逐键相同），所以不设 */
const METHOD = "时家" as const;

/** 距节气交接多近就要提示「局数可能与权威历书不同」（分钟） */
const NEAR_TERM_MINUTES = 15;

export interface CastInput {
  /** 起局模式：shijia=时家问事盘（默认）/ nianjia=年家本命盘 */
  mode?: unknown;
  /** YYYY-MM-DD；不传就用当前北京时间那一天 */
  date?: unknown;
  /** HH:mm 或 HH:mm:ss；不传就用当前北京时间 */
  time?: unknown;
  /** 城市名（内置经纬度表）；与 lon/lat 二选一 */
  city?: unknown;
  lon?: unknown;
  lat?: unknown;
  /** 真太阳时校正，默认开启（任务书指定） */
  useTrueSolarTime?: unknown;
  /** 问题类型，只认白名单；年家本命盘忽略此项（用固定的本命格局侧重） */
  questionType?: unknown;
}

export interface CastOk {
  ok: true;
  chart: Extract<QimenOutcome, { ok: true }>["chart"];
}

/** 入参解析结果：把「认不出来」和「认出来了」分开，route 只负责把 missing 原样回给前端 */
export function castChart(input: CastInput): QimenOutcome {
  // 模式：nianjia=年家本命盘，其余（含不传）一律按时家问事盘。
  const mode: QimenMode = input.mode === "nianjia" ? "nianjia" : "shijia";
  const isNatal = mode === "nianjia";

  const nowStamp = shanghaiStamp();
  const dateStr = typeof input.date === "string" ? input.date.trim() : "";
  const timeStr = typeof input.time === "string" ? input.time.trim() : "";

  // 年家本命盘必须有根：出生日期和出生时间都不能留空，不能退回到「当前北京时间」。
  // 放在 resolveWallClock 之前，避免「只给了一个」被静默补成 now 而算错盘。
  if (isNatal && (!dateStr || !timeStr)) {
    return {
      ok: false,
      missing: TEXT_MISSING_BIRTH,
      detail: `收到 date=${dateStr} time=${timeStr}，本命盘必须给完整的出生年/月/日/时`,
    };
  }

  const beijing = resolveWallClock(input.date, input.time, nowStamp);
  if (!beijing) return { ok: false, missing: TEXT_MISSING_INPUT, detail: `收到 date=${String(input.date ?? "")} time=${String(input.time ?? "")}，当前北京时间 ${nowStamp}` };

  const place = resolvePlace(input.city, input.lon, input.lat);
  if (!place) {
    return {
      ok: false,
      missing: TEXT_MISSING_CITY,
      detail: `收到 city=${String(input.city ?? "")} lon=${String(input.lon ?? "")} lat=${String(input.lat ?? "")}`,
    };
  }

  if (beijing.year < LIB_YEAR_MIN || beijing.year > LIB_YEAR_MAX) {
    return { ok: false, missing: TEXT_OUT_OF_RANGE, detail: `起局年份 ${beijing.year}` };
  }

  const useTST = input.useTrueSolarTime === undefined ? DEFAULT_TRUE_SOLAR_TIME : input.useTrueSolarTime !== false;
  const offset = useTST ? trueSolarOffsetMinutes(place.lon, dayOfYear(beijing)) : 0;
  const cast = useTST ? addMinutes(beijing, offset) : beijing;

  // 真太阳时开了且偏移不为零时，另算一次「北京时间原本会落到哪个时柱」：
  // 校正可能跨时辰，跨了必须在界面上说清楚，否则用户以为盘没变。
  let beijingHourPillar: string | null = null;
  if (useTST && Math.abs(offset) >= 0.05) {
    const bjDate = wallClockToDate(beijing);
    const bjSnap = createCalendarSnapshot(bjDate, { lateZiHourMode: LATE_ZI_HOUR_MODE });
    const bjIdx = getNativeHourIndex(bjDate);
    beijingHourPillar = bjSnap.hours[bjIdx]?.ganZhi ?? null;
  }

  const date = wallClockToDate(cast);
  const snapshot = createCalendarSnapshot(date, { lateZiHourMode: LATE_ZI_HOUR_MODE });
  const hourIndex = getNativeHourIndex(date);
  // 时家问事用 METHOD（时家）；年家本命用年家——开源库原生支持 method:"年家"，输出的是以年定局的不同盘。
  const result = calculateFromSnapshot(snapshot, date, { method: isNatal ? "年家" : METHOD });

  return adaptChart({
    result,
    snapshot,
    hourIndex,
    beijing,
    cast,
    trueSolar: {
      enabled: useTST,
      longitude: place.lon,
      // 两个分量都由内核算，服务层不重写公式：经度差 (lon−120)×4、均时差 = 合计 − 经度差
      longitudeMinutes: useTST ? longitudeOffsetMinutes(place.lon) : 0,
      equationOfTimeMinutes: useTST ? equationOfTimeMinutes(dayOfYear(beijing)) : 0,
      offsetMinutes: offset,
      corrected: formatWallClock(cast),
      hourPillarChanged: !!beijingHourPillar && beijingHourPillar !== result.info.siZhu.time,
      beijingHourPillar,
    },
    questionType: isNatal ? NATAL_QUESTION_TYPE : normalizeQuestionType(input.questionType),
    lateZiHourMode: LATE_ZI_HOUR_MODE,
    mode,
    computedAt: nowStamp,
    nearTermWarning: nearTermWarning(cast, snapshot.solarTermName),
  });
}

// ---------- 内部 ----------

function resolveWallClock(dateIn: unknown, timeIn: unknown, nowStamp: string): WallClock | null {
  const hasDate = typeof dateIn === "string" && dateIn.trim() !== "";
  const hasTime = typeof timeIn === "string" && timeIn.trim() !== "";
  if (!hasDate && !hasTime) {
    // 都没传＝「现在」，用 shanghaiStamp() 拆出挂钟（nowStamp 形如 2026-09-21 15:30:12）
    return parseWallClock(nowStamp.slice(0, 10), nowStamp.slice(11));
  }
  // 只传了一个也不猜另一半：日期缺就用今天、时间缺就用 00:00 会把盘起错，宁可报错
  if (!hasDate || !hasTime) {
    return parseWallClock(hasDate ? dateIn : nowStamp.slice(0, 10), hasTime ? timeIn : null);
  }
  return parseWallClock(dateIn, timeIn);
}

function resolvePlace(cityIn: unknown, lonIn: unknown, latIn: unknown): { lon: number; lat: number; name: string } | null {
  const city = cityByName(typeof cityIn === "string" ? cityIn : null);
  if (city) return city;
  if (coordOk(lonIn, latIn)) return { lon: lonIn as number, lat: latIn as number, name: `自定义（东经 ${lonIn}°，北纬 ${latIn}°）` };
  return null;
}

/**
 * 节气交接临近提示。
 * lite 版节气是解析近似（实测与紫金山天文台公布值差 2–6 分钟：2026 夏至库算 16:19:22 / 公布 16:25，
 * 冬至库算 04:47:57 / 公布 04:50），而局数是在节气交接的那一刻翻的（实测 2026-12-22 04:47 阴遁七局
 * → 04:48 阳遁七局），所以贴着交接时刻起局，结果可能与权威历书差一个局。这种情况必须提前说，
 * 不能等用户自己发现盘对不上。
 *
 * 比较一律走「墙钟数字」而不是 Date.getTime()：库返回的节气 Date 是按本地 getter 暴露北京时间的，
 * 直接比毫秒会把宿主机时区算进差值，换台非东八区的机器这条提示就永远不响（或永远乱响）。
 */
function nearTermWarning(cast: WallClock, termName: string): string | null {
  const castMs = wallClockMs(cast);
  let nearest: { name: string; diffMin: number } | null = null;
  for (const y of [cast.year - 1, cast.year, cast.year + 1]) {
    for (const t of getSolarTerms(y)) {
      const diffMin = Math.abs(wallClockMs(dateToWallClock(t.date)) - castMs) / 60000;
      if (!nearest || diffMin < nearest.diffMin) nearest = { name: t.name, diffMin };
    }
  }
  if (!nearest || nearest.diffMin > NEAR_TERM_MINUTES) return null;
  return `起局时刻距「${nearest.name}」交接仅 ${nearest.diffMin.toFixed(1)} 分钟（当前节气判定为${termName}）。`
    + `开源库 lite 版节气为解析近似，与紫金山天文台公布值相差分钟级，贴着交接时刻起局的局数可能与权威历书不同。`;
}
