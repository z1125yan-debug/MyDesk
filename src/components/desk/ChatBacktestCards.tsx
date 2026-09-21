"use client";
// P7-⑧④ 对话里的回测结果卡。
//
// 这个组件只做两件事：按 jobId 问现成的回测查询接口、把拿到的任务交给量化页那张卡去画。
// 为什么结果不在对话消息里存一份：
//  - 存了就要在这里再画一套指标网格，两套渲染迟早和量化页对不上（任务书明确要求复用现有回测组件）；
//  - run_backtest 最多替模型等 60 秒，任务本身不会因此被取消 —— 超时那一轮前端也得继续看得见的进度，
//    而「按 id 现查」天然支持这件事，刷新页面后凭 localStorage 里的 jobId 也照样接得上。
// 轮询节拍与状态判定用的是 LabTabs 里那份 useJobPoll（2.5 秒一次，跑完自己停），不在这里另写一套。
import { useEffect } from "react";
import { BacktestJobCard, useJobPoll, type JobView } from "./quant/LabTabs";
import { TEXT_JOB_GONE } from "@/lib/desk/backtest-core";
import type { StepInfo } from "@/lib/desk/chat-core";

/** 一个任务一张卡（hook 必须待在组件本体里，所以逐条渲染靠这个子组件，不靠循环里调 hook） */
function OneJobCard({ jobId }: { jobId: string }) {
  const { job, startPolling, missing } = useJobPoll("backtest");
  useEffect(() => {
    startPolling(jobId);
    // jobId 变了就重挂一次轮询；startPolling 是稳定引用（useCallback [poll, stop]），不放依赖也不会漏
  }, [jobId, startPolling]);
  // 任务号问不出东西：界面必须说一句实话，而不是留一块空白让人以为「跑完了但系统没给结果」。
  // 本轮的真实数字仍在上面那行步骤 detail 里，这里只说明「这张卡为什么画不出来」。
  if (missing) {
    return (
      <div className="rounded-md border border-border px-2 py-1.5 text-[11.5px] text-muted-foreground">
        {TEXT_JOB_GONE}：{missing}。本轮步骤里已列出的读数不受影响；要回看完整结果，请到量化研究页按实验台账查该任务号。
      </div>
    );
  }
  return <BacktestJobCard job={job as JobView | null} />;
}

/**
 * 一条回答里可能有几次回测（模型先被白名单挡一次、换个因子再跑一次），
 * 所以按步骤逐条画，不去重、也不合并成一张：两次跑的是不同因子组合，合成一张就说不清了。
 */
export default function ChatBacktestCards({ steps }: { steps?: StepInfo[] }) {
  const jobs = (steps ?? []).filter((s) => s.tool === "run_backtest" && typeof s.jobId === "string" && s.jobId);
  if (!jobs.length) return null;
  return (
    <div className="mt-1.5 space-y-2">
      {jobs.map((s) => (
        <div key={`${s.step}-${s.jobId}`}>
          <div className="mb-1 text-[10.5px] text-muted-foreground">
            回测任务 {s.jobId} · 由本轮 run_backtest 启动 · 下方按这个任务号现查量化研究页的同一组件（数据源 em 真实行情；历史回测不代表未来收益）
          </div>
          <OneJobCard jobId={s.jobId as string} />
        </div>
      ))}
    </div>
  );
}
