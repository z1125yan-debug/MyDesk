// P7-⑨ 奇门遁甲 —— 纯内核（不 import 开源库、不碰 db、不 fetch、不取时钟）。
//
// 这一层只做三件事，全都可以离线单测：
//  1) 把开源库 qimendunjia-lite 的原始输出，适配成任务书要求的目标结构
//     { calendar, ganzhi, chart }；
//  2) 真太阳时校正的纯算术（经度差 + 均时差），以及城市经纬度表；
//  3) 解盘 prompt 的拼装与模型回复的分段解析。
//
// 为什么开源库的类型不在这里 import：core 一旦 import 三方包，单测就要跟着装包、
// 打包也会把它拖进核心链路。这里按「结构镜像」写一遍字段，service 层负责把真实对象传进来；
// 字段对不上时 adaptChart 会如实报 missing，不会悄悄填默认值（严格禁止虚构盘局）。
//
// 实测口径（2026 全年 1460 个时刻逐一验证，探针记录见 worklog P7-⑨ 条目）：
//  - 中宫地盘干恒寄坤二宫：1460/1460；
//  - 三奇六仪完整：地盘 10 干（9 干 + 中宫寄干）、天盘 11 干（禽芮宫重复显示中宫天盘干）、暗干 9 干；
//  - 八门/八神各 8 个不同且中宫为空，九星 8 格（天禽与天芮合称「禽芮」占一格）；
//  - (节气, 元) → 局数 共 72 组零冲突，与传统十八局口诀逐条吻合；
//  - info.kong 是**时柱**旬空（1460/1460），不是日柱旬空——这条最容易读错，所以单独标了 kong_kind；
//  - dayMarkerArr/timeMarkerArr 按 baseOrder 索引，取值只有 ""、"空"、"马"、"马 空"（同宫合并，按空格拆）；
//  - 库自称支持 1900–2100，实际两端整年都算不出来（要取前后一年的冬至），可用区间是 1901–2099。

/** 开源库名与版本：版本与 package.json 里装的那个由单测对齐，防止悄悄漂到别的版本 */
export const LIB_NAME = "qimendunjia-lite";
export const LIB_VERSION = "0.1.0";

/** 任务书指定：默认时区 Asia/Shanghai、真太阳时校正默认开启 */
export const DEFAULT_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_TRUE_SOLAR_TIME = true;

/** 东八区中央经线：真太阳时的经度差按它算 */
export const STANDARD_MERIDIAN = 120;
/** 每 1 度经度 = 4 分钟时差 */
export const MINUTES_PER_DEGREE = 4;

/** 任务书指定复用的洛书顺序（3×3 盘面按行读出的宫号） */
export const LUOSHU_ORDER = [4, 9, 2, 3, 5, 7, 8, 1, 6] as const;

/**
 * 库**自称**支持的年份区间（它的报错原文就是这句：year must be an integer from 1900 to 2100）。
 * 但实测 1900 与 2100 两个整年全都算不出来——库要取前后一年的冬至/夏至来定阴阳遁半年区，
 * 于是 1900-01-01 触发「received 1899」、2100-12-31 触发「received 2101」，两个整年逐月逐日验过无一例外。
 * 所以对外用的是下面那对「实测可用区间」，这两个常量只留着解释报错原文。
 */
export const LIB_YEAR_ADVERTISED_MIN = 1900;
export const LIB_YEAR_ADVERTISED_MAX = 2100;
/** 实测可用区间：1901-01-01 00:30 与 2099-12-31 23:30 都能正常出盘（含早晚子时） */
export const LIB_YEAR_MIN = 1901;
export const LIB_YEAR_MAX = 2099;

export const TEXT_MISSING_INPUT = "起局时间没填对：需要 YYYY-MM-DD 与 HH:mm（或 HH:mm:ss）";
export const TEXT_MISSING_CITY = "城市不在内置经纬度表里，也没有给经纬度";
export const TEXT_LIB_ERROR = "开源排盘库返回错误";
export const TEXT_LIB_SHAPE = "开源排盘库输出的字段与预期结构不符（适配层不敢猜，按缺失处理）";
export const TEXT_OUT_OF_RANGE = `起局年份超出开源库实测可用区间 ${LIB_YEAR_MIN}–${LIB_YEAR_MAX}`
  + `（库自称支持 ${LIB_YEAR_ADVERTISED_MIN}–${LIB_YEAR_ADVERTISED_MAX}，但两端的整年因为它要取前后一年的冬至而算不出来）`;
export const TEXT_LUNAR_MISSING = "农历本次未取到（运行环境缺中文 ICU 数据，不影响干支与九宫）";
export const TEXT_CENTER_HOST_MISSING = "本次未在开源库输出里找到中宫地盘干的寄宫（不猜一个宫位顶上）";

/**
 * 中宫寄宫规则文案：**寄到哪个宫由库的输出实算**，这里只负责把它说出来。
 * 为什么不当常量写死「寄坤二宫」：2026 全年 1095 个时刻实测确实恒为坤二宫（单测钉住了），
 * 但那是观测结果不是我们定的规则；写死一句话，等库换了版本悄悄改成寄艮八宫，界面上还在念旧口径。
 */
export function centerRuleText(host: { name: string; palace: number } | null): string {
  return host
    ? `中宫无星门神，其地盘干寄${host.name}${host.palace}宫（按开源库本次输出实算，非写死）`
    : `中宫无星门神；${TEXT_CENTER_HOST_MISSING}`;
}

// ---------- 宫位元数据（后天八卦方位，用于把库的宫号翻译成人能读的方位） ----------

export interface PalaceMeta {
  /** 卦名 */
  name: string;
  /** 方位 */
  direction: string;
  /** 本宫所管地支（空亡标记落宫校验用的就是这张表） */
  zhi: string;
}

export const PALACE_META: Record<number, PalaceMeta> = {
  1: { name: "坎", direction: "北", zhi: "子" },
  2: { name: "坤", direction: "西南", zhi: "未申" },
  3: { name: "震", direction: "东", zhi: "卯" },
  4: { name: "巽", direction: "东南", zhi: "辰巳" },
  5: { name: "中", direction: "中宫", zhi: "" },
  6: { name: "乾", direction: "西北", zhi: "戌亥" },
  7: { name: "兑", direction: "西", zhi: "酉" },
  8: { name: "艮", direction: "东北", zhi: "丑寅" },
  9: { name: "离", direction: "南", zhi: "午" },
};

/** 3×3 盘面：按洛书顺序切成三行，UI 直接照这个画，不再自己排 */
export function luoshuGrid(): number[][] {
  return [LUOSHU_ORDER.slice(0, 3) as number[], LUOSHU_ORDER.slice(3, 6) as number[], LUOSHU_ORDER.slice(6, 9) as number[]];
}

// ---------- 城市经纬度表（内地 31 个省级行政区首府 + 5 个计划单列市） ----------

export type CityKind = "直辖市" | "省会" | "自治区首府" | "计划单列市";

export interface CityEntry {
  name: string;
  kind: CityKind;
  /** 东经，度。精度 ±0.05°≈真太阳时 ±12 秒，起局足够 */
  lon: number;
  /** 北纬，度。均时差公式只用经度，纬度是为了「经纬度表」名副其实并供界面显示 */
  lat: number;
}

/**
 * 覆盖任务书要求的「所有省会 + 计划单列市」。
 * 纬度不参与真太阳时计算（公式只吃经度差），列出来是为了界面能如实显示选的是哪个城市。
 */
export const CITIES: CityEntry[] = [
  { name: "北京", kind: "直辖市", lon: 116.41, lat: 39.90 },
  { name: "天津", kind: "直辖市", lon: 117.20, lat: 39.13 },
  { name: "上海", kind: "直辖市", lon: 121.47, lat: 31.23 },
  { name: "重庆", kind: "直辖市", lon: 106.55, lat: 29.56 },
  { name: "石家庄", kind: "省会", lon: 114.51, lat: 38.04 },
  { name: "太原", kind: "省会", lon: 112.55, lat: 37.87 },
  { name: "沈阳", kind: "省会", lon: 123.43, lat: 41.80 },
  { name: "长春", kind: "省会", lon: 125.32, lat: 43.82 },
  { name: "哈尔滨", kind: "省会", lon: 126.53, lat: 45.80 },
  { name: "南京", kind: "省会", lon: 118.80, lat: 32.06 },
  { name: "杭州", kind: "省会", lon: 120.15, lat: 30.28 },
  { name: "合肥", kind: "省会", lon: 117.28, lat: 31.86 },
  { name: "福州", kind: "省会", lon: 119.30, lat: 26.08 },
  { name: "南昌", kind: "省会", lon: 115.86, lat: 28.68 },
  { name: "济南", kind: "省会", lon: 117.12, lat: 36.65 },
  { name: "郑州", kind: "省会", lon: 113.62, lat: 34.75 },
  { name: "武汉", kind: "省会", lon: 114.31, lat: 30.60 },
  { name: "长沙", kind: "省会", lon: 112.94, lat: 28.23 },
  { name: "广州", kind: "省会", lon: 113.26, lat: 23.13 },
  { name: "海口", kind: "省会", lon: 110.35, lat: 20.02 },
  { name: "成都", kind: "省会", lon: 104.07, lat: 30.57 },
  { name: "贵阳", kind: "省会", lon: 106.63, lat: 26.65 },
  { name: "昆明", kind: "省会", lon: 102.83, lat: 24.88 },
  { name: "西安", kind: "省会", lon: 108.94, lat: 34.34 },
  { name: "兰州", kind: "省会", lon: 103.83, lat: 36.06 },
  { name: "西宁", kind: "省会", lon: 101.78, lat: 36.62 },
  { name: "呼和浩特", kind: "自治区首府", lon: 111.75, lat: 40.84 },
  { name: "南宁", kind: "自治区首府", lon: 108.37, lat: 22.82 },
  { name: "拉萨", kind: "自治区首府", lon: 91.13, lat: 29.65 },
  { name: "银川", kind: "自治区首府", lon: 106.23, lat: 38.49 },
  { name: "乌鲁木齐", kind: "自治区首府", lon: 87.62, lat: 43.83 },
  { name: "大连", kind: "计划单列市", lon: 121.62, lat: 38.91 },
  { name: "青岛", kind: "计划单列市", lon: 120.38, lat: 36.07 },
  { name: "宁波", kind: "计划单列市", lon: 121.55, lat: 29.87 },
  { name: "厦门", kind: "计划单列市", lon: 118.09, lat: 24.48 },
  { name: "深圳", kind: "计划单列市", lon: 114.06, lat: 22.55 },
];

/** 按名取城市：只认表里有的，认不出来就是 null（不猜经纬度） */
export function cityByName(name: string | null | undefined): CityEntry | null {
  const key = (name ?? "").trim();
  if (!key) return null;
  return CITIES.find((c) => c.name === key) ?? null;
}

/** 经纬度合法性：库只支持 1900–2100 的时间，经度必须落在东经 73–136（中国范围），纬度 3–54 */
export function coordOk(lon: unknown, lat: unknown): boolean {
  return typeof lon === "number" && isFinite(lon) && lon >= 73 && lon <= 136
    && typeof lat === "number" && isFinite(lat) && lat >= 3 && lat <= 54;
}

// ---------- 问题类型（表单白名单，不给自由文本进 prompt） ----------

export interface QuestionType {
  value: string;
  label: string;
  /** 给模型的一句限定，避免它把术数当成行情结论 */
  hint: string;
}

export const QUESTION_TYPES: QuestionType[] = [
  { value: "decision", label: "投资决策", hint: "问的是要不要动手，重点看用神旺衰与门神组合" },
  { value: "timing", label: "买卖时机", hint: "问的是什么时候动手，重点看值符值使与九星流转" },
  { value: "trend", label: "行情趋势", hint: "问的是后市方向，重点看阴阳遁与三奇六仪分布" },
  { value: "risk", label: "持仓风险", hint: "问的是已有仓位怎么办，重点看空亡、驿马与凶门落宫" },
  { value: "negotiation", label: "合作谈判", hint: "问的是与人交涉，重点看六合、值符与对方用神" },
  { value: "career", label: "事业发展", hint: "问的是工作职务，重点看开门、值符与年命落宫" },
  { value: "other", label: "其他", hint: "问的是别的事，按盘面通解，不要硬套投资框架" },
];

/** 只认白名单里的问题类型；认不出来退回「其他」，不把用户自由文本塞进 prompt */
export function normalizeQuestionType(v: unknown): QuestionType {
  const key = typeof v === "string" ? v.trim() : "";
  return QUESTION_TYPES.find((q) => q.value === key || q.label === key) ?? QUESTION_TYPES[QUESTION_TYPES.length - 1];
}

// ---------- 真太阳时（纯算术） ----------

/** 一天里的第几天（1–366），均时差近似公式的入参 */
export function dayOfYear(wc: WallClock): number {
  const days = [31, isLeap(wc.year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let n = wc.day;
  for (let i = 0; i < wc.month - 1; i++) n += days[i];
  return n;
}

export function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * 均时差（equation of time），单位分钟：真太阳时 − 平太阳时。
 * 用的是通行的解析近似 B = 2π(N−81)/364，EoT = 9.87·sin2B − 7.53·cosB − 1.5·sinB，
 * 全年幅度约 −14.6 ~ +16.5 分钟，误差 1 分钟量级。
 * 极值方向容易记反，所以单测按实算把它钉住：doy 303（10 月底）取最大 +16.45，doy 44（2 月中）取最小 −14.60，
 * 全年落在 [−17, +17]——换公式或换错符号都会当场红。
 * （天文上真太阳时在 11 月初最快、2 月中旬最慢，本近似把极值日各差了两三天，分钟数对得上。）
 */
export function equationOfTimeMinutes(doy: number): number {
  const b = (2 * Math.PI * (doy - 81)) / 364;
  return 9.87 * Math.sin(2 * b) - 7.53 * Math.cos(b) - 1.5 * Math.sin(b);
}

/** 经度差带来的时差：(东经 − 120) × 4 分钟。乌鲁木齐约 −129.5 分钟，与常识的 2 小时量级一致 */
export function longitudeOffsetMinutes(lon: number): number {
  return (lon - STANDARD_MERIDIAN) * MINUTES_PER_DEGREE;
}

export interface TrueSolarTime {
  /** 是否真的做了校正（关掉时 offsetMinutes 记 0，但 enabled=false，界面据此说明） */
  enabled: boolean;
  longitude: number;
  /** 经度差分量（分钟） */
  longitudeMinutes: number;
  /** 均时差分量（分钟） */
  equationOfTimeMinutes: number;
  /** 合计偏移（分钟，含正负） */
  offsetMinutes: number;
  /** 校正后的挂钟串，也就是真正拿去起局的时间 */
  corrected: string;
  /** 校正后与北京时间的时柱是否不同（不同时必须在界面明说，否则用户会以为盘没变） */
  hourPillarChanged: boolean;
  /** 北京时间的时柱（未校正），用于对照 */
  beijingHourPillar: string | null;
}

/** 合计偏移，单位分钟（未取整，四舍五入到 0.1 分显示） */
export function trueSolarOffsetMinutes(lon: number, doy: number): number {
  return longitudeOffsetMinutes(lon) + equationOfTimeMinutes(doy);
}

// ---------- 挂钟时间（core 不碰 Date 的「现在」，只做显式数字的算术） ----------

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;   // 1-31
  hour: number;  // 0-23
  minute: number;
  second: number;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** 严格解析：只认 YYYY-MM-DD 与 HH:mm[:ss]，认不出来返回 null（不接受「2026/9/1」这种，避免歧义） */
export function parseWallClock(dateStr: unknown, timeStr: unknown): WallClock | null {
  if (typeof dateStr !== "string" || typeof timeStr !== "string") return null;
  const d = DATE_RE.exec(dateStr.trim());
  const t = TIME_RE.exec(timeStr.trim());
  if (!d || !t) return null;
  const wc: WallClock = {
    year: Number(d[1]), month: Number(d[2]), day: Number(d[3]),
    hour: Number(t[1]), minute: Number(t[2]), second: t[3] ? Number(t[3]) : 0,
  };
  if (wc.month < 1 || wc.month > 12 || wc.day < 1 || wc.day > 31) return null;
  if (wc.hour > 23 || wc.minute > 59 || wc.second > 59) return null;
  // 用 UTC 反算一次，挡掉 2026-02-30 这种日历上不存在的日子
  const probe = Date.UTC(wc.year, wc.month - 1, wc.day);
  const back = new Date(probe);
  if (back.getUTCFullYear() !== wc.year || back.getUTCMonth() !== wc.month - 1 || back.getUTCDate() !== wc.day) return null;
  return wc;
}

export function formatWallClock(wc: WallClock): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(wc.year, 4)}-${p(wc.month)}-${p(wc.day)} ${p(wc.hour)}:${p(wc.minute)}:${p(wc.second)}`;
}

/**
 * 挂钟加减分钟。走 UTC 算术再取回各字段：用本地时间做加减会被夏令时/时区偏移二次污染，
 * 而中国虽然不用夏令时，这个函数不该依赖「服务器恰好在中国」这件事。
 */
export function addMinutes(wc: WallClock, minutes: number): WallClock {
  const base = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
  const moved = new Date(base + Math.round(minutes * 60000));
  return {
    year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate(),
    hour: moved.getUTCHours(), minute: moved.getUTCMinutes(), second: moved.getUTCSeconds(),
  };
}

/**
 * 挂钟 → Date（**本地构造器**）。
 * 开源库内部一律用 getFullYear()/getMonth()/getDate()/getHours() 这类本地 getter（实测 19 处，
 * 一个 UTC getter 都没有），所以要让它读到我们想要的「上海挂钟」，就得造一个本地读数正好等于
 * 这串数字的 Date。这样排盘结果与服务器时区无关：换成 UTC 时区的机器跑，结果也一样。
 */
export function wallClockToDate(wc: WallClock): Date {
  return new Date(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
}

/**
 * 挂钟 → 「把这串数字当成 UTC 读出来的毫秒数」。
 * 这不是一个真实时刻，只是把挂钟压成可比较的标量：两个挂钟之差就是它们相差的分钟数，
 * 与服务器时区无关。凡是「拿库给的墙钟数字和我们的墙钟数字比大小」都走这里，
 * 不要直接用 Date.getTime()——那会把宿主机时区偷偷算进差值（见 wallClockToDate 的说明）。
 */
export function wallClockMs(wc: WallClock): number {
  return Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
}

/**
 * Date → 挂钟（读**本地** getter）。
 * 开源库算出来的节气时刻就是这种「本地读数＝北京时间墙钟」的 Date，
 * 所以要跟用户填的墙钟比，必须先按本地读数取回数字，再走 wallClockMs。
 */
export function dateToWallClock(d: Date): WallClock {
  return {
    year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
    hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds(),
  };
}

// ---------- 开源库输出的结构镜像 ----------

export type PalaceKey = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
export type PalaceMap = Record<PalaceKey, string>;

export interface LibJuShu {
  jieQiName: string;
  type: "yang" | "yin";
  number: number;
  yuan: string;
  fullName: string;
  formatCode: string;
}

export interface LibSiZhu { year: string; month: string; day: string; time: string }

export interface LibQimenResult {
  info: {
    date: string; lunar: string; jieqi: string; ju: string; fu: string; shi: string;
    kong: string; siZhu: LibSiZhu; xunshou: string;
  };
  baseArr: { diPan: string }[];
  starArr: { star: string; tianpan: string }[];
  gateArr: string[];
  godArr: string[];
  dayMarkerArr: string[];
  timeMarkerArr: string[];
  anGanArr: string[];
  baseOrder: PalaceKey[];
  isYinDun: boolean;
  starAngle: number;
  gateAngle: number;
  godAngle: number;
  raw: {
    siZhu: LibSiZhu; juShu: LibJuShu; xunShou: string;
    diPan: PalaceMap; tianPan: PalaceMap; jiuXing: PalaceMap;
    baMen: PalaceMap; baShen: PalaceMap; anGan: PalaceMap;
  };
}

export interface LibCalendarSnapshot {
  solarDate: string;
  lunarDate: string;
  solarYear: number;
  julianDay: number;
  winterSolsticeJulianDay: number;
  summerSolsticeJulianDay: number;
  nextWinterSolsticeJulianDay: number;
  solarTermName: string;
  yearGanZhi: string;
  monthGanZhi: string;
  dayGanZhi: string;
  dayXun: string;
  monthXun: string;
  yearXun: string;
  hours: { ganZhi: string; xun: string }[];
}

export interface LibErrorResult { error: true; message: string }

// ---------- 目标结构（任务书 §四.2 指定的形状） ----------

export interface QimenPalace {
  palace: number;
  name: string;
  direction: string;
  /** 地盘干原样（中宫寄宫时是 "壬\n丙" 这种多干格） */
  earth_stem: string;
  earth_stems: string[];
  /** 天盘干原样（中宫与禽芮宫会重复显示同一组） */
  sky_stem: string;
  sky_stems: string[];
  star: string;
  door: string;
  god: string;
  ang_gan: string;
  /** 日家标记，已按空格拆开：[]、["空"]、["马"]、["马","空"] */
  day_marker: string[];
  hour_marker: string[];
  is_center: boolean;
  /** 中宫地盘干寄到本宫（实测恒为坤二宫） */
  hosts_center: boolean;
  /** 天禽寄宫：禽芮所在，天盘的中宫双干在此重复显示 */
  hosts_sky_center: boolean;
}

export interface QimenChart {
  calendar: {
    solar: { date: string; time: string; timezone: string };
    solar_term: string;
    true_solar_time: TrueSolarTime;
    /** 农历串；运行环境缺中文 ICU 时是 null，并带一句说明，不编一个 */
    lunar: string | null;
    lunar_note: string | null;
  };
  ganzhi: { year: string; month: string; day: string; hour: string; day_xun: string; hour_xun: string };
  chart: {
    dun_type: "阳遁" | "阴遁";
    ju_number: number;
    yuan: string;
    full_name: string;
    jieqi: string;
    palaces: QimenPalace[];
    /** 按洛书顺序切好的三行宫号，UI 直接照画 */
    grid: number[][];
    zhifu: string;
    zhishi: string;
    /** 空亡地支 */
    kong: string;
    /** 这个 kong 是谁的旬空——实测是时柱，写清楚免得被当成日空 */
    kong_kind: string;
    /** 旬首（info.xunshou 形如「甲午辛」）与本旬遁干（raw.xunShou 形如「辛」） */
    xunshou: string;
    xunshou_stem: string;
    base_order: PalaceKey[];
    angles: { star: number; gate: number; god: number };
    late_zi_hour_mode: string;
  };
  question_type: { value: string; label: string; hint: string };
  /** 起局口径的出处标注：REAL_DATA_ONLY 纪律要求每块数据都能说出自己从哪来 */
  provenance: {
    engine: string;
    engine_version: string;
    method: string;
    rules: string[];
    cast_from: string;
    computed_at: string;
  };
  /** 如实提示：节气交接临近、农历缺失、真太阳时改了时柱等 */
  warnings: string[];
  raw: { info: LibQimenResult["info"]; raw: LibQimenResult["raw"]; snapshot: LibCalendarSnapshot; markers: { baseOrder: PalaceKey[]; day: string[]; hour: string[] } };
}

export type QimenOutcome = { ok: true; chart: QimenChart } | { ok: false; missing: string; detail?: string };

// ---------- 适配 ----------

const PALACE_KEYS: PalaceKey[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

/** 多干格拆开：库里用 "\n" 分隔同宫两干，标记数组用 " " 分隔同宫两标记 */
export function splitCell(cell: unknown): string[] {
  if (typeof cell !== "string") return [];
  return cell.split(/[\n\s]+/).map((s) => s.trim()).filter(Boolean);
}

/** 中宫地盘干寄到哪个宫：按库的真实输出找（含中宫干的多干格），不写死「2」 */
export function hostsCenterPalace(diPan: PalaceMap): number | null {
  const center = splitCell(diPan["5"])[0];
  if (!center) return null;
  for (const k of PALACE_KEYS) {
    if (k === "5") continue;
    const stems = splitCell(diPan[k]);
    if (stems.length > 1 && stems.includes(center)) return Number(k);
  }
  return null;
}

/** 天禽寄哪个宫：九星里含「禽」的那一格（实测与天芮同宫，库写作「禽芮」） */
export function qinPalace(jiuXing: PalaceMap): number | null {
  for (const k of PALACE_KEYS) if (jiuXing[k]?.includes("禽")) return Number(k);
  return null;
}

/** 库的 baseOrder 里某个宫号的下标；找不到返回 -1（标记数组就是按这个下标索引的） */
export function markerIndexOf(baseOrder: PalaceKey[], palace: number): number {
  return baseOrder.indexOf(String(palace) as PalaceKey);
}

/** info.jieqi 带「节气：」前缀，结构化字段要纯名 */
export function bareTermName(jieqi: string): string {
  return (jieqi ?? "").replace(/^节气[：:]\s*/, "").trim();
}

/** 库的 error 分支与「年份超界」都从这里如实透出，不吞掉也不改写成成功 */
export function libFailureVerdict(res: unknown): { missing: string; detail?: string } | null {
  const r = res as (LibErrorResult & { message?: string }) | null;
  if (!r || typeof r !== "object") return { missing: TEXT_LIB_SHAPE };
  if ("error" in r && r.error) {
    const msg = typeof r.message === "string" ? r.message : "";
    if (/year must be an integer/.test(msg)) return { missing: TEXT_OUT_OF_RANGE, detail: msg };
    return { missing: TEXT_LIB_ERROR, detail: msg };
  }
  return null;
}

export interface AdaptInput {
  result: LibQimenResult;
  snapshot: LibCalendarSnapshot;
  /** 时辰在 snapshot.hours 里的下标（由 service 用库的 getNativeHourIndex 算好传进来） */
  hourIndex: number;
  /** 用户填的北京挂钟（未校正） */
  beijing: WallClock;
  /** 真正拿去起局的挂钟（开了真太阳时就是校正后的） */
  cast: WallClock;
  trueSolar: TrueSolarTime;
  questionType: QuestionType;
  lateZiHourMode: string;
  /** 服务端时间戳，只能来自 shanghaiStamp() */
  computedAt: string;
  /** 节气交接临近提示（service 用库的 getSolarTerms 算好传进来；没有就不提示） */
  nearTermWarning?: string | null;
}

/** 目标结构必需的字段是否齐全：缺一个就按缺失处理，绝不用默认值补 */
export function shapeOk(res: LibQimenResult, snap: LibCalendarSnapshot): boolean {
  if (!res || !res.info || !res.raw) return false;
  const r = res.raw;
  if (!r.juShu || typeof r.juShu.number !== "number") return false;
  for (const m of ["diPan", "tianPan", "jiuXing", "baMen", "baShen", "anGan"] as const) {
    const pm = r[m] as Partial<PalaceMap> | undefined;
    if (!pm) return false;
    for (const k of PALACE_KEYS) if (typeof pm[k] !== "string") return false;
  }
  if (!Array.isArray(res.baseOrder) || res.baseOrder.length !== 8) return false;
  for (const a of ["dayMarkerArr", "timeMarkerArr"] as const) {
    if (!Array.isArray(res[a]) || res[a].length !== 8) return false;
  }
  if (!snap || typeof snap.dayGanZhi !== "string" || !Array.isArray(snap.hours)) return false;
  return true;
}

export function adaptChart(inp: AdaptInput): QimenOutcome {
  const fail = libFailureVerdict(inp.result);
  if (fail) return { ok: false, ...fail };
  if (!shapeOk(inp.result, inp.snapshot)) return { ok: false, missing: TEXT_LIB_SHAPE };

  const { result: res, snapshot: snap } = inp;
  const r = res.raw;
  const hostCenter = hostsCenterPalace(r.diPan);
  const hostQin = qinPalace(r.jiuXing);
  const hourEntry = snap.hours[inp.hourIndex];

  const palaces: QimenPalace[] = PALACE_KEYS.map((k) => {
    const p = Number(k);
    const meta = PALACE_META[p];
    const di = markerIndexOf(res.baseOrder, p);
    return {
      palace: p,
      name: meta.name,
      direction: meta.direction,
      earth_stem: r.diPan[k] ?? "",
      earth_stems: splitCell(r.diPan[k]),
      sky_stem: r.tianPan[k] ?? "",
      sky_stems: splitCell(r.tianPan[k]),
      star: r.jiuXing[k] ?? "",
      door: r.baMen[k] ?? "",
      god: r.baShen[k] ?? "",
      ang_gan: r.anGan[k] ?? "",
      day_marker: di >= 0 ? splitCell(res.dayMarkerArr[di]) : [],
      hour_marker: di >= 0 ? splitCell(res.timeMarkerArr[di]) : [],
      is_center: p === 5,
      hosts_center: hostCenter === p,
      hosts_sky_center: hostQin === p,
    };
  });

  const warnings: string[] = [];
  if (!snap.lunarDate) warnings.push(TEXT_LUNAR_MISSING);
  if (hostCenter === null) warnings.push(TEXT_CENTER_HOST_MISSING);
  if (inp.trueSolar.enabled && inp.trueSolar.hourPillarChanged) {
    warnings.push(
      `真太阳时校正把时柱从 ${inp.trueSolar.beijingHourPillar ?? "？"} 改成了 ${res.info.siZhu.time}`
      + `（偏移 ${inp.trueSolar.offsetMinutes.toFixed(1)} 分钟，跨了时辰），盘面按校正后的时间起局`,
    );
  }
  if (inp.nearTermWarning) warnings.push(inp.nearTermWarning);

  return {
    ok: true,
    chart: {
      calendar: {
        solar: {
          date: formatWallClock(inp.beijing).slice(0, 10),
          time: formatWallClock(inp.beijing).slice(11),
          timezone: DEFAULT_TIMEZONE,
        },
        solar_term: snap.solarTermName || bareTermName(res.info.jieqi),
        true_solar_time: inp.trueSolar,
        lunar: snap.lunarDate || null,
        lunar_note: snap.lunarDate ? null : TEXT_LUNAR_MISSING,
      },
      ganzhi: {
        year: res.info.siZhu.year,
        month: res.info.siZhu.month,
        day: res.info.siZhu.day,
        hour: res.info.siZhu.time,
        day_xun: snap.dayXun,
        hour_xun: hourEntry?.xun ?? "",
      },
      chart: {
        dun_type: r.juShu.type === "yang" ? "阳遁" : "阴遁",
        ju_number: r.juShu.number,
        yuan: r.juShu.yuan,
        full_name: r.juShu.fullName,
        jieqi: r.juShu.jieQiName,
        palaces,
        grid: luoshuGrid(),
        // info.fu/info.shi 原文是「值符：天心」「值使：开门」，结构化字段只留名字
        zhifu: res.info.fu.replace(/^值符[：:]\s*/, ""),
        zhishi: res.info.shi.replace(/^值使[：:]\s*/, ""),
        kong: res.info.kong,
        kong_kind: "时柱旬空（实测：info.kong 跟随时柱，不是日柱）",
        xunshou: res.info.xunshou,
        xunshou_stem: r.xunShou,
        base_order: res.baseOrder,
        angles: { star: res.starAngle, gate: res.gateAngle, god: res.godAngle },
        late_zi_hour_mode: inp.lateZiHourMode,
      },
      question_type: inp.questionType,
      provenance: {
        engine: `${LIB_NAME}（本地计算，未调用任何外部接口）`,
        engine_version: LIB_VERSION,
        method: "时家奇门",
        rules: [
          `真太阳时校正：${inp.trueSolar.enabled ? `开启（东经 ${inp.trueSolar.longitude}°，合计偏移 ${inp.trueSolar.offsetMinutes.toFixed(1)} 分钟）` : "关闭（按北京时间起局）"}`,
          `时区：${DEFAULT_TIMEZONE}`,
          centerRuleText(palaces.find((p) => p.hosts_center) ?? null),
          `晚子时口径：${inp.lateZiHourMode === "next-day" ? "次日起日柱" : "当日起日柱（库默认）"}`,
          "节气由开源库本地解析近似算出（lite 版），与紫金山天文台公布值相差分钟级",
        ],
        cast_from: `按${inp.trueSolar.enabled ? "真太阳时" : "北京时间"} ${formatWallClock(inp.cast)} 起局`,
        computed_at: inp.computedAt,
      },
      warnings,
      raw: {
        info: res.info,
        raw: r,
        snapshot: snap,
        markers: { baseOrder: res.baseOrder, day: res.dayMarkerArr, hour: res.timeMarkerArr },
      },
    },
  };
}

// ---------- 解盘 prompt（只用盘面里真实存在的字） ----------

/**
 * 盘面事实文本：一行一宫，按洛书顺序。
 * 只写库里给出来的东西——中宫的星/门/神本来就是空，写成「（无）」而不是替它编一个。
 */
export function chartFactsText(chart: QimenChart): string {
  const c = chart.chart;
  const byNo = (p: number) => c.palaces.find((x) => x.palace === p);
  // 寄宫也从盘面里读，不写死「坤二宫」：写给模型看的每一个字都必须能在这次输出里找到出处
  const host = c.palaces.find((x) => x.hosts_center) ?? null;
  const lines = LUOSHU_ORDER.map((p) => {
    const x = byNo(p);
    if (!x) return "";
    const tags = [
      ...(x.day_marker.length ? [`日:${x.day_marker.join("")}`] : []),
      ...(x.hour_marker.length ? [`时:${x.hour_marker.join("")}`] : []),
    ];
    return [
      `${p}宫 ${x.name}（${x.direction}）`,
      `天盘 ${x.sky_stems.join("+") || "（无）"}`,
      `地盘 ${x.earth_stems.join("+") || "（无）"}`,
      `九星 ${x.star || "（无）"}`,
      `八门 ${x.door || "（无）"}`,
      `八神 ${x.god || "（无）"}`,
      `暗干 ${x.ang_gan || "（无）"}`,
      x.is_center ? (host ? `【中宫，地盘干寄${host.name}${host.palace}宫】` : `【中宫，${TEXT_CENTER_HOST_MISSING}】`) : "",
      x.hosts_center ? "【承中宫地盘干】" : "",
      x.hosts_sky_center ? "【禽芮同宫，承中宫天盘干】" : "",
      tags.length ? `【${tags.join(" ")}】` : "",
    ].filter(Boolean).join(" · ");
  });
  const cal = chart.calendar;
  return [
    `起局时间（北京时间）：${cal.solar.date} ${cal.solar.time}（${cal.solar.timezone}）`,
    `真太阳时：${cal.true_solar_time.enabled
      ? `${cal.true_solar_time.corrected}（东经 ${cal.true_solar_time.longitude}°，偏移 ${cal.true_solar_time.offsetMinutes.toFixed(1)} 分钟）`
      : "未启用，按北京时间起局"}`,
    `农历：${cal.lunar ?? "本次未取到"}`,
    `节气：${cal.solar_term}`,
    `四柱：${chart.ganzhi.year}年 ${chart.ganzhi.month}月 ${chart.ganzhi.day}日 ${chart.ganzhi.hour}时`,
    `日旬：${chart.ganzhi.day_xun}　时旬：${chart.ganzhi.hour_xun}`,
    `局数：${c.dun_type}${c.ju_number}局（${c.yuan}）`,
    `值符：${c.zhifu}　值使：${c.zhishi}`,
    `空亡：${c.kong}（${c.kong_kind}）`,
    `旬首：${c.xunshou}`,
    "",
    "九宫盘面（按洛书顺序）：",
    ...lines,
  ].join("\n");
}

export const QIMEN_SYSTEM_PROMPT = [
  "你是奇门遁甲解盘助手，为一个 A 股个人工作台服务。",
  "【硬约束】",
  "1. 只能使用用户给出的盘面数据。盘面里没有的干支、星、门、神、宫位、局数，一个字都不许补，也不许凭记忆改。",
  "2. 奇门遁甲是传统术数推演，不是市场数据、不是事实、不是投资建议。全文必须保持这个定性，不得写成「一定」「必然」「保证涨」。",
  "   凡属你的解读，措辞要用「我认为 / 倾向于 / 盘面上看」，不要写成对市场的客观陈述。",
  "3. 不得给出具体价位、涨跌幅、仓位比例、买卖点位这类数字承诺；不得把术数结论包装成行情事实或研究结论。",
  "4. 遇到盘面数据缺失或自相矛盾，直接说明缺什么，不要替它圆。",
  "5. 简体中文，克制、具体，不堆砌套话。",
  "【输出格式】严格输出三段，每段以小标题开头，不要额外前后言：",
  "核心结论：（3 句以内，说清盘面主要格局与用神状态）",
  "操作建议：（3 条以内，写成「倾向于/宜/不宜」的参考语气）",
  "风险提示：（2 条以内，必须含一句「术数推演不构成投资建议」）",
].join("\n");

/**
 * 拼装解盘 prompt。
 * 固定模板 + 真实盘面：问题类型只从白名单取，用户自由文本不进 prompt（避免把任意输入当指令注入）。
 */
export function buildInterpretPrompt(chart: QimenChart): string {
  return [
    `问题类型：${chart.question_type.label}`,
    `该类型的解盘侧重：${chart.question_type.hint}`,
    "",
    "以下是本地开源排盘引擎算出的盘面（已核验结构完整，全部为真实计算结果）：",
    "",
    chartFactsText(chart),
    "",
    `起局口径：${chart.provenance.rules.join("；")}`,
    `排盘引擎：${chart.provenance.engine} v${chart.provenance.engine_version}，${chart.provenance.method}`,
    chart.warnings.length ? `需要注意的提示：${chart.warnings.join("；")}` : "",
    "",
    "请按系统提示词的三段格式解这个盘。",
  ].filter(Boolean).join("\n");
}

export interface Interpretation {
  /** 三段是否都解析出来了；解析不出来就整段放 full，不硬切成三块 */
  parsed: boolean;
  core: string;
  advice: string;
  risk: string;
  full: string;
}

// 小标题允许 markdown 加粗：`**核心结论：**`（*在冒号外）或 `**核心结论**：`（*在冒号内）都要认，
// 否则同一段解盘因为模型多写了两个星号就被判成「没解析出来」。
// P7-⑩ 豆包变体：有的模型把小标题写成 markdown 标题行（`# 核心结论` 后直接换行、不带冒号），
// 这类行首标题同样认——只加识别，不放宽「切不齐就 parsed=false」的口径。
const HEAD_CORE = /核心结论\*{0,2}\s*[：:]|(?:^|\n)\s{0,3}#{1,4}\s*\*{0,2}核心结论\*{0,2}\s*(?=\n|$)/;
const HEAD_ADVICE = /操作建议\*{0,2}\s*[：:]|(?:^|\n)\s{0,3}#{1,4}\s*\*{0,2}操作建议\*{0,2}\s*(?=\n|$)/;
const HEAD_RISK = /风险提示\*{0,2}\s*[：:]|(?:^|\n)\s{0,3}#{1,4}\s*\*{0,2}风险提示\*{0,2}\s*(?=\n|$)/;

/**
 * 切模型回复的三段。
 * 只按小标题切，切不齐就 parsed=false 并把原文整段交出去——
 * 硬切会把「没有风险提示」显示成一个空标题，那是把缺失画成了结构。
 */
export function parseInterpretation(text: string): Interpretation {
  const full = (text ?? "").trim();
  const ic = full.search(HEAD_CORE);
  const ia = full.search(HEAD_ADVICE);
  const ir = full.search(HEAD_RISK);
  if (ic < 0 || ia < 0 || ir < 0 || !(ic < ia && ia < ir)) return { parsed: false, core: "", advice: "", risk: "", full };
  // 段内两头都要剥掉残留的加粗星号：前导是本段小标题的 `**`，
  // 尾部是**下一段**小标题的 `**`（因为 to 指向下一段标题文字，星号在它前面，会被切进本段）。
  const seg = (from: number, headLen: number, to: number) =>
    full.slice(from + headLen, to < 0 ? full.length : to)
      .replace(/^\s*\*+\s*/, "")
      .replace(/\s*\*+\s*$/, "")
      .trim();
  return {
    parsed: true,
    core: seg(ic, full.slice(ic).match(HEAD_CORE)![0].length, ia),
    advice: seg(ia, full.slice(ia).match(HEAD_ADVICE)![0].length, ir),
    risk: seg(ir, full.slice(ir).match(HEAD_RISK)![0].length, -1),
    full,
  };
}

/** 界面上一句话说明「这块数据从哪来」，与项目里其它面板的出处口径一致 */
export function provenanceLine(chart: QimenChart): string {
  return `${chart.provenance.engine} v${chart.provenance.engine_version} · ${chart.provenance.method} · ${chart.provenance.cast_from} · 生成于 ${chart.provenance.computed_at}`;
}
