// P8 子轮 C⑥ SSE 断点续传回归测试（run-bus-core 纯核 + run-bus 服务层 + 3 条进程内 e2e + 接线钉）。
//
// 每条断言都对应用户口径里一句会被问到的话：
//  - 「续传不重跑分析」：留底里只有已经发生的帧，replay 拿不回没发过的东西；
//  - 「丢了底不自动重问」：run 没了 → replay 返回 null（路由据此 404），客户端只 warning + 收口；
//  - 「逐出如实带缺头」：gap=true 必须出现，绝不假装重放是完整的；
//  - 「没挂底的轮次逐字回落 A/B」：run 被拒 ⇒ 帧不带 seq ⇒ 客户端续传门槛（resumeSince>0）不触发。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RUN_MAX_CHARS, RUN_MAX_EVENTS, createRunBuffer, sweepFinished } from "../../src/lib/desk/run-bus-core.ts";
import { RUN_BUS_FINISHED_TTL_MS, RUN_BUS_MAX_RUNS, createRunBus } from "../../src/lib/desk/run-bus.ts";
import { encodeStreamEvent } from "../../src/lib/desk/chat-stream-core.ts";
import type { StreamEvent } from "../../src/lib/desk/chat-stream-core.ts";

/** 源码文本断言统一走相对本文件的 URL：不依赖 node --test 的启动目录 */
const readSrc = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

const delta = (content: string): StreamEvent => ({ type: "delta", data: { content } });

// ---------- run-bus-core：帧与序号 ----------

test("publish 序号从 1 自增；坏形状直接不收（不给假序号），闸值就是细则钉的两个数", () => {
  assert.equal(RUN_MAX_EVENTS, 600);
  assert.equal(RUN_MAX_CHARS, 1_000_000);
  const b = createRunBuffer();
  assert.equal(b.publish(delta("a")), 1);
  assert.equal(b.publish(delta("b")), 2);
  for (const bad of [null, undefined, {}, { data: {} }, { type: 1 }]) {
    assert.equal(b.publish(bad as never), null, "不认识的帧不留底");
  }
  assert.equal(b.lastSeq(), 2, "坏帧不占序号");
  assert.equal(b.size(), 2);
});

test("超帧数上限逐旧保新，evictedTo 如实记缺口：要起点之前逐出过 ⇒ gap=true，绝不谎称完整", () => {
  const b = createRunBuffer({ maxEvents: 3 });
  for (let i = 1; i <= 5; i++) b.publish(delta(String(i)));
  assert.equal(b.size(), 3);
  assert.deepEqual(b.replaySince(0).frames.map((f) => f.seq), [3, 4, 5]);
  assert.equal(b.replaySince(0).gap, true, "1、2 号帧被逐出：从头要就是缺头的");
  assert.equal(b.replaySince(3).gap, false, "起点在留存区内就不算缺头");
  assert.equal(b.evictedTo(), 2);
});

test("超字符上限同样逐旧，但单帧破例至少保一帧：续传哪怕只接得上最后一帧也是接得上", () => {
  const b = createRunBuffer({ maxChars: 10 });
  b.publish(delta("小"));
  b.publish(delta("这一条足够长会把前一条挤出去".repeat(4)));
  assert.equal(b.size(), 1);
  assert.equal(b.replaySince(0).frames[0].seq, 2);
  assert.equal(b.replaySince(0).gap, true);
});

test("封卷后拒收事后帧：publish 回 null、finalSeq 停在收口那一刻；seal 幂等", () => {
  const b = createRunBuffer();
  b.publish(delta("a"));
  b.publish({ type: "done", data: { fullText: "a" } });
  b.seal();
  assert.equal(b.sealed(), true);
  assert.equal(b.finalSeq(), 2);
  assert.equal(b.publish(delta("事后")), null, "done 之后再 publish 是链路 bug，不给序号让调用方去裸发");
  b.seal(); // 幂等：不覆写 finalSeq
  assert.equal(b.finalSeq(), 2);
});

test("GC 计划是纯函数：只列「封卷且到期」的，活口与未到期一个不碰；时钟由调用方注入", () => {
  const at = 1_000_000;
  const doomed = sweepFinished([
    { id: "old", sealed: true, finishedAt: at - RUN_BUS_FINISHED_TTL_MS },
    { id: "fresh", sealed: true, finishedAt: at - RUN_BUS_FINISHED_TTL_MS + 1 },
    { id: "alive", sealed: false, finishedAt: null },
    { id: "nofin", sealed: true, finishedAt: null },
  ], at, RUN_BUS_FINISHED_TTL_MS);
  assert.deepEqual(doomed, ["old"], "到期这一条之外都不该动");
});

// ---------- run-bus 服务层：订阅、上限、取消 ----------

test("publish 的行自带顶层 seq 且与裸编码同形；没有该 run 时回 null（路由据此裸发）", () => {
  const bus = createRunBus();
  assert.equal(bus.publish("ghost", delta("x")), null);
  bus.start("r1");
  const pub = bus.publish("r1", delta("x"))!;
  assert.equal(pub.seq, 1);
  assert.equal(pub.line, encodeStreamEvent(delta("x"), 1));
  assert.match(pub.line, /^data: \{"type":"delta","data":\{"content":"x"\},"seq":1\}\n\n$/);
});

test("start 的三种拒绝都给出可复述的原因：撞号不静默重建、坏 id 不收、满员且全活口就如实拒", () => {
  const bus = createRunBus();
  assert.equal(bus.start("").ok, false);
  assert.equal(bus.start("r").ok, true);
  const dup = bus.start("r");
  assert.equal(dup.ok, false);
  assert.match(dup.error ?? "", /已有留底：不静默重建/);
  // 塞满 20 个活口后第 21 个被拒——新轮次照常跑，只是不可续传
  const bus2 = createRunBus();
  for (let i = 0; i < RUN_BUS_MAX_RUNS; i++) assert.equal(bus2.start(`a${i}`).ok, true);
  const full = bus2.start("overflow");
  assert.equal(full.ok, false);
  assert.match(full.error ?? "", /留底位已满（20）且都在执行/);
  // 有封卷的让位：逐「封卷最早」，活口谁也不挤谁
  bus2.seal("a0");
  bus2.publish("a1", delta("还在跑")); // a1 未封卷
  bus2.seal("a1");
  assert.equal(bus2.start("overflow").ok, true);
  assert.equal(bus2.replay("a0", 0), null, "a0 封卷最早，让位的是它");
  assert.notEqual(bus2.replay("a1", 0), null);
});

test("cancel 幂等且只认存在的 run；cancelled 只报事实不催别的动作", () => {
  const bus = createRunBus();
  bus.start("r");
  assert.equal(bus.cancelled("r"), false);
  assert.equal(bus.cancel("r").ok, true);
  assert.equal(bus.cancel("r").ok, true, "重复停止不算错");
  assert.equal(bus.cancelled("r"), true);
  const gone = bus.cancel("nope");
  assert.equal(gone.ok, false);
  assert.match(gone.error ?? "", /没有留底（已被回收或从未挂底）/);
});

// ---------- 进程内 e2e（createRunBus + 假订阅者，真对账） ----------

test("e2e 断流续传全流程：订阅者掐线后按 lastSeq 重放 + 重挂，最终帧序列不重、不缺、不乱序", () => {
  const bus = createRunBus();
  bus.start("run-1");
  const got: string[] = [];
  let lastSeq = 0;
  const feed = (line: string | null) => {
    if (line === null) return;
    const ev = JSON.parse(line.replace(/^data: /, "").trim()) as StreamEvent & { seq?: number };
    if (typeof ev.seq === "number") {
      if (ev.seq <= lastSeq) return; // 客户端水位去重（与 chat-stream-client 同一判据）
      lastSeq = ev.seq;
    }
    got.push(ev.type === "delta" ? ev.data.content : ev.type);
  };
  const unsub = bus.subscribe("run-1", feed);
  bus.publish("run-1", delta("第一"));
  bus.publish("run-1", delta("第二"));
  unsub(); // ——假「刷新」：连接断了，producer 不停（细则拍板点 3：断连不取消上游）——
  bus.publish("run-1", delta("第三"));
  bus.publish("run-1", { type: "done", data: { fullText: "第一第二第三" } });
  // ——续传：先重放断点之后的，再挂上订阅（路由里这两步同一次同步建立）——
  const replay = bus.replay("run-1", lastSeq)!;
  assert.equal(replay.gap, false);
  for (const f of replay.frames) feed(encodeStreamEvent(f.event, f.seq));
  const unsub2 = bus.subscribe("run-1", feed);
  bus.seal("run-1");
  unsub2();
  assert.deepEqual(got, ["第一", "第二", "第三", "done"], "续传只是补上断点后的帧，一个字都不重");
  assert.equal(lastSeq, 4);
});

test("e2e 封卷即收流：活订阅者只会被叫醒一次（done 由 producer 发、null 由 seal 发），挂上已封卷的 run 立刻拿到收尾信号", () => {
  const bus = createRunBus();
  bus.start("run-2");
  const events: Array<string | null> = [];
  bus.subscribe("run-2", (line) => events.push(line === null ? "closed" : "frame"));
  bus.publish("run-2", { type: "done", data: { fullText: "答" } });
  bus.seal("run-2");
  assert.deepEqual(events, ["frame", "closed"]);
  // 迟到的订阅者（续传挂上来的）不该挂死等一个永远不来的 done：立刻收到 closed
  const late: Array<string | null> = [];
  bus.subscribe("run-2", (line) => late.push(line === null ? "closed" : "frame"));
  assert.deepEqual(late, ["closed"]);
  // 封卷的 run 仍在重放窗口内：done 帧本身能拿回去（收口消息的展示依据）
  assert.equal(bus.replay("run-2", 0)!.frames[0].event.type, "done");
});

test("e2e 到期回收＝续传的 404 语义：TTL 一到 sweep 收走，replay 回 null，客户端由此走「warning + 就地收口」而不是重问", () => {
  let clock = 1_000;
  const bus = createRunBus(() => clock);
  bus.start("run-3");
  bus.publish("run-3", delta("内容"));
  bus.seal("run-3");
  assert.notEqual(bus.replay("run-3", 0), null, "5 分钟窗口内还能续");
  clock += RUN_BUS_FINISHED_TTL_MS - 1;
  assert.equal(bus.sweep(), 0, "差一秒都不收：窗口就是 5 分钟这个数");
  clock += 1;
  assert.equal(bus.sweep(), 1);
  assert.equal(bus.replay("run-3", 0), null, "没了就是没了：不拿空重放冒充「续上了」");
  assert.equal(bus.cancelled("run-3"), false);
});

// ---------- 接线钉：两个 producer 路由、/api/ai/run、客户端顺序 ----------

test("producer 路由挂底三闸：只有流式+字符串 run 才挂；拒挂就当没 run 照常跑；isCancelled 在挂底轮改看取消旗", () => {
  for (const rel of ["src/app/api/ai/proxy/route.ts", "src/app/api/ai/chat/route.ts"]) {
    const src = readSrc(rel);
    assert.match(src, /let runId: string \| null = wantStream && typeof body\?\.run === "string" && body\.run \? body\.run : null;/, `${rel}：非流式永不挂底（JSON 路不碰 RunBus）`);
    assert.match(src, /if \(runId && !RUNS\.start\(runId\)\.ok\) runId = null;/, `${rel}：拒挂不报错，按无 run 正常跑`);
    assert.match(src, /runId \? RUNS\.cancelled\(runId\) : req\.signal\.aborted/, `${rel}：挂底轮断连不再立即取消上游；无 run 轮逐字保留 P7 语义`);
    assert.match(src, /RUNS\.seal\(runId\)/, `${rel}：收尾必先封卷`);
    assert.match(src, /const pub = runId \? RUNS\.publish\(runId, ev\) : null;/, `${rel}：留底失败退回裸发`);
  }
});

test("/api/ai/run：stop 幂等打招呼、未知 action 如实拒、没底 404 文案指到病根、缺头 warning 只写进本连接", () => {
  const src = readSrc("src/app/api/ai/run/route.ts");
  assert.match(src, /缺少 run（非空字符串）/);
  assert.match(src, /本端点只认 stop\/resume/);
  assert.match(src, /status: 404/);
  assert.match(src, /本轮已无留底（服务重启或超出 5 分钟保留窗口）：不可续传，保留断点前内容即可/);
  assert.match(src, /断点前部分事件已过期未留底（留底有上限），本轮正文以收尾的 done 为准。/);
  assert.match(src, /replay\.sealed/, "已封卷：重放完就收流，不挂订阅");
  assert.match(src, /RUNS\.subscribe\(run/, "还活着：重放与订阅同一次同步建立");
});

test("客户端续传链：水位去重在 applyEvent 之前；顺序是「续传一次 → 仍不行才兜底」；兜底一轮最多一次；gone 不再重问", () => {
  const client = readSrc("src/lib/desk/chat-stream-client.ts");
  assert.match(client, /if \(ev\.seq <= state\.lastSeq\) return;/, "重复送达的旧帧在传输层就丢掉");
  const uc = readSrc("src/lib/desk/use-chat.ts");
  assert.match(uc, /if \(ctrl\.signal\.aborted \|\| fallbackStarted\) return;/, "兜底幂等闸");
  const iResume = uc.indexOf("await tryResumeOnce(result.error");
  const iFallback = uc.indexOf('await runFallback(result.error || "流式未送达任何事件")');
  assert.ok(iResume > 0 && iFallback > iResume, "续传插在兜底之前，且只插不改（原判定原文还在）");
  assert.match(uc, /resumeSince > 0/, "门槛：服务端真认了挂底（收到过带 seq 帧）才续");
  assert.match(uc, /resumeGaveUp = true/, "gone：只 warning 收口，挡掉后面的兜底");
  assert.match(uc, /不自动重问。/, "拍板点 1 原话进界面文案");
  assert.match(uc, /runRef: closed \? undefined : \{ id: run, lastSeq \}/, "刷新后的续传锚点随收口清除");
  assert.match(uc, /action: "stop", run/, "停止按钮显式通知服务端取消（挂底轮断连已不再自动取消）");
});

test("A/B 轮既有语义零漂移：无 run/无 seq 时帧形状、降级顺序、断连文案都还是原来那句（用源码原文钉）", () => {
  const uc = readSrc("src/lib/desk/use-chat.ts");
  assert.match(uc, /已手动停止，回答到此处为止（未补全）。/);
  assert.match(uc, /流式未完成（\$\{reason\}），已改用整体请求。/);
  const proxy = readSrc("src/app/api/ai/proxy/route.ts");
  assert.match(proxy, /场景自动调度未完成，本轮按「无自动取数」继续回答/);
  // 没挂底的轮次：publish 根本不执行，编码走裸 encode —— 与 A/B 逐字节一致
  assert.match(proxy, /pub \? pub\.line : encodeStreamEvent\(ev\)/);
});
