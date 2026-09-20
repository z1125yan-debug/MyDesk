"use client";
// P7-⑧② 对话链路的跳转联动接线：把「正文里的可点片段」和「跳到哪」连起来。
//
// 为什么单独一个 hook：唯一对话页和右下角小窗是同一个会话的两个入口，跳转口径必须一模一样
// （否则同一只票在小窗里切 K 线、在那边切画像，就是 P7-⑤ 之前「两个入口各做一套」的老毛病）。
// 判定不在这里（link-core 负责），这里只管：取一次板块白名单 + 两个 store 动作。
import { useCallback, useEffect, useState } from "react";
import type { DeskLink, SectorRef } from "./link-core";
import { fetchSectorRefs } from "./market";
import { useDesk } from "./store";

export function useDeskLinks(): { sectors: SectorRef[]; openLink: (link: DeskLink) => void } {
  const go = useDesk((s) => s.go);
  const setFocusSymbol = useDesk((s) => s.setFocusSymbol);
  const setFocusSector = useDesk((s) => s.setFocusSector);
  const [sectors, setSectors] = useState<SectorRef[]>([]);

  // 榜单只在挂载时取一次：白名单只用来决定「哪些名字可点」，不是行情展示，没必要跟着刷新周期打接口。
  // 取不到就是空清单 = 正文里的板块名一律不可点（不猜、不用演示榜单兜底，见 fetchSectorRefs）。
  useEffect(() => {
    let dead = false;
    void fetchSectorRefs().then((rows) => { if (!dead && rows.length) setSectors(rows); });
    return () => { dead = true; };
  }, []);

  const openLink = useCallback((link: DeskLink) => {
    if (link.kind === "symbol") {
      setFocusSymbol(link.symbol);
      go("analysis");
      return;
    }
    setFocusSector(link.code);
    go("sectors");
  }, [go, setFocusSymbol, setFocusSector]);

  return { sectors, openLink };
}
