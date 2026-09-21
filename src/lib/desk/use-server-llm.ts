"use client";
// P7-⑩ 任务4：把服务端模型通道的状态接进 React 渲染循环。
// ai.ts 里那份模块级缓存是命令式的（供非组件代码同步判 aiReady），这里只负责
// 「订阅 + 快照」：available:false 落地时让门和文案跟着翻面，除此之外不制造第二次真相。
import { useSyncExternalStore } from "react";
import { subscribeServerLlm, getServerLlmInfo } from "./ai";
import type { ServerLlmPublic } from "../llm/model-config-core.ts";

export function useServerLlm(): ServerLlmPublic | null {
  return useSyncExternalStore(subscribeServerLlm, getServerLlmInfo, getServerLlmInfo);
}
