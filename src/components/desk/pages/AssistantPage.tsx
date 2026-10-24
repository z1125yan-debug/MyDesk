"use client";
// 智能助手页 —— P7-⑥⑥ 起它是**唯一的对话页**：AI 首页的大输入框和右下角随问小窗都把话交到这里发。
//
// 这一页只保留「本页特有的东西」：行情快照怎么取、系统提示词怎么拼；
// 发送、流式回填、降级、价格校验、端点选择都在 useChatSend 里，和首页 / 小窗共用同一份实现。
// 会话是同一份 store：从小窗「在助手页继续」＝切到同一条会话，不复制消息。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot, History, Plus, Send, Square, Trash2,
  TrendingUp, BarChart3, Filter, Target, Scale, PieChart, LineChart, Compass,
  ImagePlus, Sparkles, X,
  // R20：八张卡随模式换（cardsForMode 从 15 张全池取），下面 7 张此前没露过面，图标一并补齐
  Wallet, ArrowDownToLine, Activity, Gauge, Crosshair, AlertTriangle, Zap,
} from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { aiConfigured, assistantSystemPrompt } from "@/lib/desk/ai";
import { fetchQuoteCards, fetchTechSnapshot, fetchNewsBlock, isDemoSymbol, searchSymbols } from "@/lib/desk/market";
import { inferMarketScopeFromSymbol } from "@/lib/desk/market-scope-core";
import { shanghaiStamp } from "@/lib/desk/session";
import {
  guardPriceOf, provenanceOfQuote, provenanceOfTechSnapshot, renderMarketContext, type CtxRow,
} from "@/lib/desk/ai-context-core";
import { isFollowUp, type ChatMessage, type ChatSession } from "@/lib/desk/chat-core";
import { nameCandidates } from "@/lib/desk/intent-core";
import { useChatSend, type SnapshotResult } from "@/lib/desk/use-chat";
import { useServerLlm } from "@/lib/desk/use-server-llm";
import { useDeskLinks } from "@/lib/desk/use-desk-links";
import Markdown from "../Markdown";
import StepTimeline from "../StepTimeline";
import SourceStrip from "../SourceStrip";
import ChatBacktestCards from "../ChatBacktestCards";
import WzDecisionWidget from "../WzDecisionWidget";
import ThinkingPlaceholder from "../ThinkingPlaceholder";
import ChatModeMenu from "../ui/ChatModeMenu";
// P11 持仓周期：与风格菜单同一套「一处定义、发送时现读」的画法（modes.ts 唯一正身）
import HorizonPicker from "../ui/HorizonPicker";
// 持仓条件小窗（标的/成本/仓位/建仓日期）：与模式/周期同一排，填一次每轮都带
import HoldPicker from "../ui/HoldPicker";
// P56 稳智「高价值对话提示词」库：数据唯一出处 prompt-library.ts，面板与本组件共用
import { PROMPT_LIBRARY, PROMPT_LIBRARY_TOTAL } from "@/lib/desk/prompt-library";

// 回答风格：清单与文案唯一出处是 @/lib/desk/modes（CHAT_MODES 画界面、MODE_NOTES 进提示词），
// 首页下拉与本页 composer 都经共享组件 ChatModeMenu 出，选中值存 store.assistantMode，
// 发送那一刻现读——不会出现「首页选了研判、这里按决策发」。

// P58 稳智「试试这样问」八张场景卡：条件（弹窗槽位）与提问拼装唯一出处 suggestion-cards-core.ts。
// 这里只做图标映射 + 「点卡 → 弹参数窗 → 校验通过才生成并发送」的接线。
// 为什么不再是「点一下就发」：稳智那张卡不是文案，是 { label, mode, text } —— mode 决定
// 要用户补哪些条件（股票/成本/仓位/操作/周期/均线），补出来的条件才决定最终问句长什么样。
import { directDispatch, needsDialog, cardTitle, type CardDispatch, type SuggestionCard } from "@/lib/desk/suggestion-cards-core";
import { cardsForMode } from "@/lib/desk/mode-cards";
import SuggestionCardDialog from "../ui/SuggestionCardDialog";
import FollowUpChips from "../ui/FollowUpChips";
import { followUpBody } from "@/lib/desk/followups-core";
import type { ChatHorizon } from "@/lib/desk/modes";

const CARD_ICONS: Record<string, typeof TrendingUp> = {
  七维分析一只股票: Compass,
  判断现在能否买入: TrendingUp,
  按成本制定持仓计划: Target,
  对比多只股票强弱: Scale,
  分析板块当前阶段: BarChart3,
  判断今日仓位策略: PieChart,
  筛选持续流入板块: Filter,
  制定股票交易计划: LineChart,
  // 同上：换到研判/深度/搜索模式后新露面的 7 张，不补就掉成 Sparkles
  持仓先拿还是减: Wallet,
  回踩低吸判断: ArrowDownToLine,
  接飞刀还是回踩: Activity,
  跌到一个月均价附近还能买吗: Gauge,
  现价还能不能参与: Crosshair,
  跌破一个月均价怎么办: AlertTriangle,
  超短轻仓试错: Zap,
};

/** direct 卡（今日仓位/筛选板块）没有参数可补，返回要直接发的问句；其余卡返回 null 表示该开窗。 */
function directPromptOf(c: SuggestionCard): string | null {
  if (needsDialog(c)) return null;
  return directDispatch(c).prompt || "";   // "" 也算"没有要发的"，别把空句丢给模型
}



// 为指定品种生成行情快照文本块。
// P6-A：每条都带来源分层（真实/派生/演示/缺失），只有标 REAL 的价格才允许当数量级校验的锚点——
// 原来演示品种（非 A 股）的假价格既被写成「最新价」当事实注入，又被拿去做幻觉校验，两处都已修正。
async function marketBlockFor(symbol: string): Promise<{ rows: CtxRow[]; block: string; price: number | null }> {
  try {
    const [cards, snap] = await Promise.all([
      fetchQuoteCards([symbol]),
      fetchTechSnapshot(symbol).catch(() => null),
    ]);
    const q = cards.cards[0];
    const prov = provenanceOfQuote(q, isDemoSymbol(symbol));
    const lines: string[] = [];
    if (prov === "REAL") {
      lines.push(`最新价 ${q.price.toFixed(2)} 元（${q.changePct >= 0 ? "+" : ""}${q.changePct.toFixed(2)}%）`);
    } else if (prov === "MISSING") {
      lines.push("最新价：本次未取到（数据源断开或停牌）——不知道就不要给价格，也不要用 0");
    } else {
      lines.push(`展示值 ${q ? q.price.toFixed(2) : "—"} 元：本机演示数据，不是行情，禁止引用为价格事实`);
    }
    const snapProv = snap ? provenanceOfTechSnapshot(snap.source) : null;
    const snapLines = snap && snapProv && snapProv !== "MISSING"
      ? [
        `多周期趋势: ${snap.tfs.map((t) => `${t.tf}=${t.trend}`).join(", ")}；RSI: ${snap.tfs.map((t) => `${t.tf} ${t.rsi?.toFixed(0) ?? "—"}`).join(", ")}`,
        snap.support != null ? `最近支撑 ${snap.support.toFixed(2)} / 最近阻力 ${snap.resistance?.toFixed(2)}` : "",
        snap.rangePos != null ? `近半年区间位置 ${snap.rangePos.toFixed(0)}%（${snap.rangeLow?.toFixed(2)} ~ ${snap.rangeHigh?.toFixed(2)}）` : "",
      ].filter(Boolean)
      : [];
    const rows: CtxRow[] = [
      {
        label: `${q?.name ?? symbol}（${symbol}）报价`,
        provenance: prov,
        lines,
        note: prov === "REAL" && q?.series_synthetic ? "分时序列为按现价合成的展示序列，只用于画缩略图，不是真实成交轨迹" : undefined,
      },
    ];
    if (snapLines.length) {
      rows.push({
        label: `${q?.name ?? symbol}（${symbol}）技术面`,
        provenance: snapProv === "DERIVED_ON_DEMO" ? "DERIVED_ON_DEMO" : "DERIVED",
        lines: snapLines,
        note: snapProv === "DERIVED_ON_DEMO" ? "K 线为演示数据：趋势/RSI/关键位只是算法演示，不构成任何结论" : "由本机引擎对真实 K 线计算（MA/RSI/区间），不是交易所发布的指标",
      });
    } else if (snap && snapProv === "MISSING") {
      rows.push({ label: `${q?.name ?? symbol}（${symbol}）技术面`, provenance: "MISSING", lines: ["K 线未取得：趋势/RSI/关键位全部缺，不要凭印象补"] });
    }
    return { rows, block: renderMarketContext(rows, { takenAt: shanghaiStamp() }), price: guardPriceOf(prov, q?.price) };
  } catch {
    return { rows: [], block: "", price: null };
  }
}

// 从自然语言问题中提取品种搜索词（整句搜索接口是不认的）
// R10b：候选切法与服务端 intent-core.nameCandidates 同一份口径（停用词表就在纯核里）。
// 3014 实测教训：问「中国电影卖的怎么样」时旧切法只产出「整句/中国电影卖」两种形状，
// 搜索接口全不认 → 客户端快照落回关注品种、价位校验锚错票；服务端却能把「中国电影」解析成 600977。
// 两边各切一套，就会出现「答的是这只票、注入的是那只票」的口径分裂。
export function questionCandidates(q: string): string[] {
  const out = new Set<string>();
  out.add(q.trim());
  const code = q.match(/\d{6}/);
  if (code) out.add(code[0]);
  for (const n of nameCandidates(q)) out.add(n);
  const stripped = q
    .replace(/^(帮我|请你|请|麻烦|帮忙|看看|看下|看一下|分析一下|分析下|分析|聊聊|说说|讲讲|查一下|查下|查查|对比一下|对比)+/g, "")
    .replace(/(的?结构|的?走势|的?行情|的?基本面|怎么样|怎么看待|怎么看|如何看|如何|现在|当前|最新|的情况|情况|支撑|阻力|关键位|价位|价格|在哪|哪里|吗|呢|？|\?)+$/g, "");
  if (stripped.length >= 2) out.add(stripped);
  return [...out].filter((s) => s.length >= 2).slice(0, 5);
}

export default function AssistantPage() {
  const go = useDesk((s) => s.go);
  const ai = useDesk((s) => s.ai);
  const focusSymbol = useDesk((s) => s.focusSymbol);
  const setFocusSymbol = useDesk((s) => s.setFocusSymbol);
  // P8-⑤：调试视图开关（默认关、只存本机）。改版把顶栏收成「新对话+状态」两件套，
  // 调试入口移到对话态顶栏右侧的小按钮——功能不丢，但不再占日常视觉。
  const debugPanel = useDesk((s) => s.debugPanel);
  const setDebugPanel = useDesk((s) => s.setDebugPanel);
  const switchSession = useDesk((s) => s.switchSession);
  const newSession = useDesk((s) => s.newSession);
  const dropSession = useDesk((s) => s.dropSession);
  // R20：卡片栏跟着当前回答风格换一批（只读；写仍然只走 ChatModeMenu）
  const assistantMode = useDesk((s) => s.assistantMode);

  const [input, setInput] = useState("");
  // P34：图片多模态（稳智对齐 P3 #15）——用户上传的图片以 base64 data URL 形式存在这里，
  // 发送时放进 payload.images 透传给后端；后端把 data URL 转成 OpenAI 兼容的 image_url content block。
  // 不压缩、不缩放（稳智口径）；个人免费版最小可行，大原图由 LLM 上游自己处理。
  const [images, setImages] = useState<string[]>([]);
  // P56：高价值提问面板开关（15 组 50 条，点一条填输入框）
  const [promptOpen, setPromptOpen] = useState(false);
  // P58：正在填参数的那张场景卡（null = 没开窗）。开窗 ≠ 发送——取消/关窗一个字都不发。
  const [cardFilling, setCardFilling] = useState<SuggestionCard | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 模式来自 store（与首页下拉同一份设置）；发送时按 use-chat 的口径在「真要发的那一刻」读当前值，
  // 所以这里不需要再养一份 ref 来绕开 setState 的异步性。
  const endRef = useRef<HTMLDivElement>(null);
  const takePendingAsk = useDesk((s) => s.takePendingAsk);
  // 2026-09-26 稳智「AI优选」：选股工作台交过来的候选池——**预填不发送**（与 pendingAsk 的「立即发」是两件事）
  // 订阅字段本身（而不是只在挂载时取一次）：既覆盖「跳页后挂载」也覆盖「已经在对话页时又来一棒」。
  const aiPoolHandoff = useDesk((s) => s.aiPoolHandoff);
  const takeAiPoolHandoff = useDesk((s) => s.takeAiPoolHandoff);
  const [poolBadge, setPoolBadge] = useState<{ label: string } | null>(null);
  // P7-⑧②：正文里的 6 位代码 / 清单内板块名渲染成可点片段。板块白名单与跳转动作出自共用 hook
  // （右下角小窗用的是同一份），这里只负责把它递给 Markdown。
  const { sectors, openLink } = useDeskLinks();

  // 本轮快照：识别问题里的品种（关注品种兜底），带来源分层；追问则沿用会话已关联的标的
  // LLM 分流：快照只注入当前市场的品种——市场切到美股/港股时，默认关注品种（上证指数）
  // 是 A 股的，注入它就等于把 A 股行情塞进美股回答；跨市场品种由服务端工具按代码取数。
  const snapshot = useCallback(async (session: ChatSession, question: string): Promise<SnapshotResult | null> => {
    const market = useDesk.getState().marketTab;
    const carried = isFollowUp(question) ? session.stock : undefined;
    let targets = [carried ?? focusSymbol];
    let hit: string | undefined = carried;
    if (!carried) {
      try {
        for (const cand of questionCandidates(question)) {
          const found = await searchSymbols(cand);
          if (found.length) {
            targets = [...new Set([found[0].symbol, focusSymbol])].slice(0, 2);
            hit = found[0].symbol;
            break;
          }
        }
      } catch { /* 识别失败则仅注入关注品种 */ }
    }
    // 只保留与当前市场同市场的品种；一个都不剩 = 本轮快照为空（服务端提示词会写 MISSING，不编数）
    targets = targets.filter((s) => (inferMarketScopeFromSymbol(s) ?? market) === market);
    if (!targets.length) return { snapshot: "", guardPrice: null, anchorSymbol: null, stock: hit };
    const blocks = await Promise.all(targets.map((s) => marketBlockFor(s)));
    const allRows = blocks.flatMap((b) => b.rows);
    const marketBlock = allRows.length
      ? `[行情快照·逐条标注来源分层]\n${renderMarketContext(allRows, { takenAt: shanghaiStamp() })}`
      : "";
    // 快讯是 A 股 7x24 口径：非 A 股轮次不注入（美股/港股消息面由服务端 market_overseas / market_news 按市场取）
    const newsBlock = market === "A" ? await fetchNewsBlock().catch(() => "") : "";
    const gi = blocks.findIndex((b) => b.price != null);
    return {
      // 快照为空时返回空串：提示词会写「状态 MISSING」，比塞一段假装有数据的文本诚实
      snapshot: [marketBlock, newsBlock].filter(Boolean).join("\n\n"),
      // 校验锚点只认真实报价：演示品种/缺失品种的 price 已经是 null，不会再拿假价判模型幻觉
      guardPrice: gi >= 0 ? blocks[gi].price : null,
      // R10b：这份价来自哪个标的要一起交出去——use-chat 拿它和本轮场景徽章的真实标的对账，
      // 锚定的不是同一只票就没有资格判「价位幻觉」（详见 use-chat 的 anchorMismatch 注释）
      anchorSymbol: gi >= 0 ? targets[gi] : null,
      stock: hit,
    };
  }, [focusSymbol]);

  const { send, busy, stop, sessions, activeSessionId } = useChatSend({
    // 端点按服务商能力选：OpenAI 兼容接口走工具调用环（模型能自己补取数），其余退回纯对话端点。
    // 两条路的场景识别与自动取数是同一份接线，所以换端点不会换「这一轮按哪个场景答」的口径。
    endpoint: "auto",
    // LLM 分流：客户端直连提示词里也声明当前市场（服务端两条端点另行注入同一份分流块）。
    systemPrompt: (ctx) => assistantSystemPrompt(ctx, useDesk.getState().marketTab),
    snapshot,
    // 当前关注品种交给服务端：说「这只股」时它才知道指谁，并且会如实标注「分析页当前品种」
    // 模式在发送那一刻从 store 现读：首页刚改完风格就提交，这一轮用的就是新值，不依赖渲染节奏
    // P11：周期同 rule——没选就是 null，请求体连 horizon 键都不带（未选≠默认某周期）
    // hold：composer 上填的持仓（标的/成本/仓位/建仓日期）与 mode/horizon 同批随请求带出。
    // 现读 getState() 而不是订阅——发送那一刻的用户选择才是这一轮的条件。
    // LLM 分流：market 同样发送那一刻现读 store.marketTab（行情页的 A/HK/US 选项卡）。
    extra: () => ({
      focusSymbol,
      mode: useDesk.getState().assistantMode,
      horizon: useDesk.getState().assistantHorizon,
      hold: useDesk.getState().holdCtx,
      market: useDesk.getState().marketTab,
    }),
    onNotConfigured: () => go("settings"),
  });

  // 首页交过来的那一句：进页面取一次就清掉，刷新不会重发。
  // 这里刻意不做任何 setState：模式已经在 store 里由首页那次点击写好了，本轮发送时现读即可。
  useEffect(() => {
    const pending = takePendingAsk();
    if (!pending) return;
    void send(pending);
  }, [send, takePendingAsk]);

  // AI优选交接（稳智 /screener「创建候选池并前往稳智AI」的本地版）：**预填问句 + 挂候选池徽章，不自动发送**。
  // 稳智源码实证：onMounted 里只 `B.value = prompt`（写输入框），没有任何 submit——用户自己点发送。
  // 周期不在这里处理：askAiWithPool 已把所选周期写进 store.assistantHorizon，发送时 use-chat 现读。
  useEffect(() => {
    if (!aiPoolHandoff) return;
    const h = takeAiPoolHandoff();
    if (!h) return;
    // 一次性交接棒消费：外部 store 事件落成本地状态，属有意的 effect 内 setState（非级联渲染）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPoolBadge({ label: h.label });
    setInput(h.prompt);
  }, [aiPoolHandoff, takeAiPoolHandoff]);

  // P10（用户裁定改口径）：切到别的页面再回来，这一轮对话要还在——刷新也还在。
  // 旧行为是挂载即 newSession()（P8 设计：回 Hello 首页），用户实测反馈「切换后再回来对话就没了」，
  // 判定那是把工程上的「新开会话干净」错当成了用户预期。会话本来就整份存在 zustand persist
  // （localStorage，删了才真没了），这里只是不再每次挂载强行开新会话；
  // 「新对话」按钮保留：想清空时点它，或直接删对应会话（空状态最近对话里的垃圾桶）。
  // 副作用口径：进页不再动会话，首页/小窗交来的 pendingAsk 就落在当前会话里续着说。

  const session = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  const messages: ChatMessage[] = session?.messages ?? [];
  // P7-⑩：徽章说的是「这一轮会走哪条模型路」。浏览器凭据与服务端 .env 通道是两条路，
  // 各写各的名字；两条都没有才说「未配置」。订阅 useServerLlm 让 available:false 落回时徽章翻面。
  const serverLlm = useServerLlm();
  const browserCfg = aiConfigured(ai);
  const configured = browserCfg || !(serverLlm && serverLlm.available === false);
  // 最近对话（有内容的历史会话，按更新时间倒序）：新会话顶掉了视图，但话还在原会话里
  const recents = sessions
    .filter((s) => s.id !== activeSessionId && s.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5);

  const submit = (preset?: string) => {
    const content = (preset ?? input).trim();
    if (!content) return;
    setInput("");
    void send(content, images.length > 0 ? images : undefined);
    setImages([]); // 发送后清空图片（图片只跟这一轮绑定，不跨轮继承）
  };

  /**
   * 点场景卡：direct 卡直接发整句，其余卡先开参数窗收条件。
   * 模式/周期是"这一轮"的条件，稳智在开窗那一刻还没定——所以这里不写 store，
   * 等弹窗确认（onCardSend）再把这张卡的条件落进 store，发送那一刻 use-chat 现读。
   */
  const openCard = (c: SuggestionCard) => {
    const direct = directPromptOf(c);
    if (direct === null) { setCardFilling(c); return; }
    if (!direct) return;                       // 拼出空句 = 没东西可发，别发
    useDesk.getState().setAssistantMode(c.chatMode);
    submit(direct);
  };

  /** 弹窗「生成并发送」：条件写回 store，再发拼好的那句 */
  const onCardSend = (d: CardDispatch, horizon: ChatHorizon | null) => {
    setCardFilling(null);
    useDesk.getState().setAssistantMode(d.chatMode);
    if (horizon) useDesk.getState().setAssistantHorizon(horizon);
    // 持仓卡填出来的成本/仓位/建仓日期写回 composer 那份持仓上下文：
    // 这一轮问句里已经带了，后面追问（「那现在要不要减」）也必须还在——否则第二句又变成没有成本的泛泛之谈。
    if (d.hold && (d.hold.cost || d.hold.position || d.hold.openDate)) useDesk.getState().setHoldCtx(d.hold);
    submit(d.prompt);
  };

  // P34：图片上传处理（稳智口径：前端不压缩、不缩放、直接上传原图）
  // 用 FileReader.readAsDataURL 把图片转成 base64 data URL，放进 images 数组。
  const handleImageUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const promises = Array.from(files).map((file) =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      })
    );
    Promise.all(promises).then((dataUrls) => {
      setImages((prev) => [...prev, ...dataUrls]);
    }).catch(() => { /* 忽略读取错误 */ });
    e.target.value = ""; // 清空 input，允许重复选择同一文件
  }, []);

  const removeImage = useCallback((idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  // 自动跟随：流式期间内容一直在长，只按条数滚动会停在半屏
  const tail = `${messages.length}:${messages.at(-1)?.content.length ?? 0}`;
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [tail]);

  // 候选池徽章（对齐稳智 candidate_pool_label）：两个 composer 分支共用同一份画法
  const poolBadgeNode = poolBadge ? (
    <div className="apple-fade-in mt-2 flex items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[13px] text-amber-200">
      <Sparkles size={13} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={poolBadge.label}>候选池：{poolBadge.label}</span>
      <span className="hidden shrink-0 text-[12px] text-amber-200/70 sm:inline">问句已预填，确认后发送</span>
      <button onClick={() => setPoolBadge(null)} aria-label="关闭候选池提示" className="shrink-0 text-amber-200/70 hover:text-amber-100"><X size={12} /></button>
    </div>
  ) : null;

  return (
    <div className="flex h-full w-full flex-col">
      {messages.length === 0 && !busy ? (
      /* ===== 空状态：居中 Hello + 宽输入 + 两列建议卡片（对齐参考站） ===== */
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto desk-scroll px-6">
        <div className="w-full max-w-3xl py-4">
          <h1 className="apple-slide-up text-center text-[45px] font-semibold tracking-tight">Hello</h1>
          <p className="apple-slide-up mt-3 text-center text-[16px] text-muted-foreground">
            问行情、问个股，或描述你想要的条件，剩下的交给我。
          </p>

          {/* 宽输入框 */}
          <div className="apple-slide-up mt-8 rounded-[20px] border border-border bg-card p-2 shadow-2xl">
            <div className="flex items-center gap-2 px-1.5 py-1.5">
              {/* P34：图片上传按钮（稳智口径：input accept image/jpeg,png,gif,webp，multiple） */}
              <button onClick={() => fileInputRef.current?.click()} disabled={!configured}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-overlay hover:text-foreground disabled:opacity-50"
                title="上传图片（支持 jpg/png/gif/webp，可多选）">
                <ImagePlus size={16} />
              </button>
              <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple
                className="hidden" onChange={handleImageUpload} />
              <ChatModeMenu disabled={!configured} />
              <HorizonPicker disabled={!configured} />
              {/* 持仓（标的/成本/仓位/建仓日期）：填一次，之后每轮都按它回答 */}
              <HoldPicker disabled={!configured} />
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
                placeholder={configured ? "输入股票、板块，或说说你的疑问…" : "配置 AI 后即可对话"}
                disabled={!configured}
                className="min-w-0 flex-1 bg-transparent px-3 py-2 text-[16px] outline-none placeholder:text-muted-foreground/50 disabled:opacity-60"
              />
              <button onClick={() => submit()} disabled={!configured || !input.trim()}
                className="apple-primary-btn flex h-10 w-10 shrink-0 items-center justify-center">
                <Send size={16} />
              </button>
            </div>
            {/* 图片预览（已选的图片缩略图 + 删除按钮） */}
            {images.length > 0 && (
              <div className="mt-1.5 flex gap-1.5 overflow-x-auto px-1.5">
                {images.map((img, i) => (
                  <div key={i} className="relative shrink-0">
                    <img src={img} alt="" className="h-12 w-12 rounded object-cover" />
                    <button onClick={() => removeImage(i)}
                      className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-background hover:bg-destructive hover:text-white">
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {poolBadgeNode}

          {/* 两列建议卡片（P57 稳智同款八张：每张自带 mode/horizon 条件，输出骨架随条件不同） */}
          <div className="apple-stagger mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {cardsForMode(assistantMode).map((c) => {
              const Icon = CARD_ICONS[c.label] ?? Sparkles;
              return (
                <button key={c.label} onClick={() => openCard(c)} disabled={!configured}
                  title={cardTitle(c)}
                  className="group flex items-center gap-3.5 rounded-2xl border border-border/60 bg-overlay px-4 py-4 text-left transition-all duration-200 hover:border-sky-400/30 hover:bg-overlay disabled:opacity-50">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-overlay-strong text-sky-300 transition-colors group-hover:bg-sky-400/15">
                    <Icon size={18} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] text-foreground/90">{c.label}</span>
                    {/* 把这张卡会带来的条件写在卡面上：用户点之前就知道这轮换成哪种答法 */}
                    <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground/60">
                      {needsDialog(c) ? "填条件后生成 · " : "直接发送 · "}{c.chatMode === "decision" ? "决策" : c.chatMode === "judge" ? "研判" : c.chatMode === "deep" ? "深度" : "搜索"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* 最近对话：改版删掉了常驻会话列表栏，但「续上之前的话」这条能力不删——
              收进空状态底部，一眼扫过不占视觉主线；没有历史时整块不出现（对齐参考站「暂无历史」的克制）。 */}
          {recents.length > 0 && (
            <div className="apple-fade-in mt-8">
              <div className="mb-2 text-[13px] text-muted-foreground/70">最近对话</div>
              <div className="space-y-1">
                {recents.map((s) => (
                  <div key={s.id} className="group flex items-center gap-2 rounded-xl px-3 py-2 transition-colors hover:bg-overlay">
                    <button onClick={() => switchSession(s.id)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                      <History size={13} className="shrink-0 text-muted-foreground/60" />
                      <span className="truncate text-[14px] text-foreground/80">{s.title || "未命名对话"}</span>
                      <span className="shrink-0 text-[12px] text-muted-foreground/50">{s.messages.length} 条</span>
                    </button>
                    <button onClick={() => dropSession(s.id)} title="删除这段对话"
                      className="opacity-0 transition-opacity hover:text-red-300 group-hover:opacity-60">
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      ) : (
      <div className="flex min-h-0 flex-1 flex-col px-5">
        {/* 顶栏：新对话 + 状态（对话态走居中单列阅读，不再常驻会话列表 / 右栏） */}
        <div className="flex items-center justify-between px-2 py-2.5">
          <button onClick={() => { newSession(); }}
            className="inline-flex items-center gap-1.5 rounded-full border border-border/70 px-3.5 py-1.5 text-[13.5px] text-muted-foreground transition-colors hover:border-sky-400/40 hover:text-sky-200">
            <Plus size={13} /> 新对话
          </button>
          <div className="flex items-center gap-2">
            {/* P8-⑤ 调试开关：默认关；开着时步骤时间线展开三段调试视图。小按钮收在右侧，不进日常视觉主线 */}
            <button onClick={() => setDebugPanel(!debugPanel)} title="调试：展示本轮真实取数步骤与留底（只存本机）"
              className={"rounded-full border px-2.5 py-1 text-[12px] transition-colors " + (debugPanel ? "border-sky-400/40 bg-sky-400/10 text-sky-200" : "border-border/60 text-muted-foreground hover:text-foreground")}>
              调试
            </button>
            <span className={"inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] " + (configured ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-300" : "border-amber-400/25 bg-amber-400/10 text-amber-300")}>
              <span className={"h-1.5 w-1.5 rounded-full " + (configured ? "bg-emerald-400" : "bg-amber-400")} />
              {configured ? "AI 已就绪" : "AI 待配置"}
            </span>
          </div>
        </div>

        {/* 居中消息流 */}
        <div className="desk-scroll flex-1 overflow-y-auto">
          <div className="wz-col space-y-6 px-6 py-6">
          {messages.map((m) => (
            <div key={m.id} className={"flex " + (m.role === "user" ? "justify-end" : "justify-start")}>
              {m.role === "user" ? (
                <div className="max-w-[80%] whitespace-pre-wrap rounded-3xl rounded-br-md bg-overlay-strong px-5 py-3 wz-user-bubble text-foreground">
                  {m.content}
                </div>
              ) : (
                <div className="flex w-full gap-3.5">
                  {/* P51 稳智字体对齐：正文度量不再写死 16px/leading-8（=行高 2.0），
                      改成稳智那两套实测值——流式中 16px/1.82、收口后 15px/1.78+letter-spacing .1px。
                      类本体在 globals.css（.wz-stream / .wz-msg），这里只切状态。 */}
                  <div className={"min-w-0 flex-1 pt-1 text-foreground/95 " + (m.streaming ? "wz-stream" : "wz-msg")}>
                    {/* 还没有正文（刚发出的那几秒）：画稳智同款「🧠 深度思考中 / ⚡ 快速分析中」占位，
                        正文一到就换成真正的 Markdown + 光标——不再只剩一个空气泡配一根闪烁光标。 */}
                    {m.streaming && !m.content ? (
                      <ThinkingPlaceholder />
                    ) : (
                      /* P62 正文彻底去框（用户对着稳智截图定的口径）：AI 说的那段话就是裸排的正文，
                          不再套 .wz-answer 外框——框只留给表格卡 / 执行条 / 输入卡，
                          阅读宽度由外层 .wz-col（居中 880px）收住。 */
                      <>
                        {/* 正文只画剥掉「追问推荐」那一行之后的部分：标记是给系统看的，不是给用户读的 */}
                        <Markdown content={followUpBody(m.content)} sectors={sectors} onLink={openLink} />
                        {m.streaming && <span className="ml-0.5 inline-block h-4 w-[7px] translate-y-1 animate-pulse bg-sky-400" />}
                        {/* 收口后才画（流式途中模型刚吐到半个标记时不闪芯片）；点一颗 = 直接问那一句 */}
                        <FollowUpChips content={m.content} streaming={m.streaming} onAsk={(q) => submit(q)} />
                      </>
                    )}
                    {/* P19 稳智决策信号 widget：紧跟正文之后、步骤时间线之前——用户第一眼看到结论卡，
                        再向下看模型说了什么、以及走了哪些真实接口。判不出来就不画（组件自身返回 null） */}
                    {m.wzDecision && <WzDecisionWidget signal={m.wzDecision} />}
                    <div className="mt-1.5">
                      <StepTimeline steps={m.steps} warning={m.warning} streaming={m.streaming}
                        intent={m.intent} debug={m.debug} debugOn={debugPanel}
                        message={{ content: followUpBody(m.content), streaming: m.streaming }} />
                    </div>
                    {/* P30 稳智对齐 P2 #13：数据源面板——按类型分组（公告/新闻/行情/资金/其他）展示本轮已核验来源 */}
                    <SourceStrip steps={m.steps} />
                    <ChatBacktestCards steps={m.steps} />
                  </div>
                </div>
              )}
            </div>
          ))}
          {busy && messages.at(-1)?.role !== "assistant" && (
            <ThinkingPlaceholder />
          )}
          <div ref={endRef} />
          </div>
        </div>

        {/* 底部简洁输入条 */}
        <div className="shrink-0 px-5 pb-2 pt-1">
          <div className="w-full">
            {/* P56 稳智对齐：高价值提问库（15 组 50 条）——点一条填进输入框，不直接发送，用户可先改标的 */}
            <div className="mb-1.5 flex items-center gap-2">
              <button onClick={() => setPromptOpen((v) => !v)} disabled={!configured}
                className={"inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] transition-colors disabled:opacity-50 " + (promptOpen ? "border-sky-400/40 bg-sky-400/10 text-sky-200" : "border-border/60 text-muted-foreground hover:text-foreground")}>
                <Sparkles size={12} /> 高价值提问 · {PROMPT_LIBRARY_TOTAL} 条
              </button>
            </div>
            {promptOpen && (
              <div className="mb-2 max-h-[42vh] space-y-3 overflow-y-auto rounded-2xl border border-border/60 bg-card p-3">
                {PROMPT_LIBRARY.map((g) => (
                  <div key={g.key}>
                    <div className="mb-1 text-[12.5px] font-medium text-foreground/80">
                      {g.emoji} {g.label}
                      <span className="ml-1.5 text-[11px] text-muted-foreground/60">{g.prompts.length}</span>
                    </div>
                    <div className="space-y-0.5">
                      {g.prompts.map((p, i) => (
                        <button key={i} onClick={() => { setInput(p); setPromptOpen(false); }}
                          className="block w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] leading-relaxed text-muted-foreground transition-colors hover:bg-overlay hover:text-foreground">
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 rounded-[20px] border border-border bg-card p-2">
              {/* P34：图片上传按钮（非空状态输入条） */}
              <button onClick={() => fileInputRef.current?.click()} disabled={!configured}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-overlay hover:text-foreground disabled:opacity-50"
                title="上传图片（支持 jpg/png/gif/webp，可多选）">
                <ImagePlus size={16} />
              </button>
              <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple
                className="hidden" onChange={handleImageUpload} />
              <ChatModeMenu disabled={!configured} />
              <HorizonPicker disabled={!configured} />
              <HoldPicker disabled={!configured} />
              <input value={input} onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
                placeholder={configured ? "输入股票代码、板块或您的投资疑问…" : "配置 AI 后即可对话"}
                disabled={!configured}
                className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-[15.5px] outline-none placeholder:text-muted-foreground/50 disabled:opacity-60" />
              {busy ? (
                <button onClick={stop} title="停止本次回答"
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-amber-500/50 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20">
                  <Square size={14} />
                </button>
              ) : (
                <button onClick={() => submit()} disabled={!configured || !input.trim()}
                  className="apple-primary-btn flex h-10 w-10 shrink-0 items-center justify-center">
                  <Send size={15} />
                </button>
              )}
            </div>
            {/* P34：图片预览（非空状态输入条） */}
            {images.length > 0 && (
              <div className="mt-1.5 flex gap-1.5 overflow-x-auto px-1">
                {images.map((img, i) => (
                  <div key={i} className="relative shrink-0">
                    <img src={img} alt="" className="h-12 w-12 rounded object-cover" />
                    <button onClick={() => removeImage(i)}
                      className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-background hover:bg-destructive hover:text-white">
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {poolBadgeNode}
            <div className="mt-1.5 text-center text-[11.5px] text-muted-foreground/50">对话只保存在本机，不会上传</div>
          </div>
        </div>
      </div>
      )}

      {/* P58 场景卡参数窗：取消/关闭一个字都不发，确认才拼句发送（对齐稳智弹窗语义） */}
      {cardFilling && (
        <SuggestionCardDialog card={cardFilling} onClose={() => setCardFilling(null)} onSend={onCardSend} />
      )}
    </div>
  );
}
