"use client";
// P15-R3a 壳层：菜单重排为一级平铺后，这里不再画第二层左窄栏（25 页的入口全部回到 Sidebar 一棵树上）。
// 保留的唯一职责：旧 hash 兼容页（已并入对话那 5 个）进来时挂横幅说出去向并给一键回对话的出口，
// 下方照常渲染原页面组件——兼容=照常能看，不是跳转拦截。
import { MessageSquareReply } from "lucide-react";
import { useDesk } from "@/lib/desk/store";
import { isLegacyPage, legacyReturnTarget } from "@/lib/desk/nav-core";

export default function WorkbenchShell(props: { children: React.ReactNode }) {
  const page = useDesk((s) => s.page);
  const go = useDesk((s) => s.go);

  if (!isLegacyPage(page)) return <>{props.children}</>;

  const back = legacyReturnTarget(page);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border/60 bg-sky-400/[0.07] px-5 py-2.5 text-[13.5px] text-sky-200/90">
        <MessageSquareReply size={14} aria-hidden />
        这类问题直接在对话里问就行，AI 会自动选好分析框架。
        {back && (
          <button onClick={() => go(back)} className="ml-auto rounded-full bg-sky-400/15 px-3 py-1 text-sky-200 hover:bg-sky-400/25">
            去对话
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1">{props.children}</div>
    </div>
  );
}
