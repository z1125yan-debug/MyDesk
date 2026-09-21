// P7-⑩ 服务端侧的模型配置读取：全项目唯一允许直接读 LLM_* 环境变量的地方。
// 判定逻辑全部在 model-config-core.ts（纯函数、可单测），这里只做 process.env 的搬运。
// 仅服务端 import；浏览器侧要判「服务端通道是否可用」请走 GET /api/llm/config。
import { resolveServerLlm, type LlmEnvLike, type ServerLlmResult } from "./model-config-core.ts";

function envLike(): LlmEnvLike {
  return {
    LLM_BASE_URL: process.env.LLM_BASE_URL,
    LLM_API_KEY: process.env.LLM_API_KEY,
    LLM_MODEL_NAME: process.env.LLM_MODEL_NAME,
  };
}

/** 每次调用都现读 env：Next 的 start 进程里 env 不会中途变，但单测与脚本可以注入不同形状。 */
export function getServerLlm(): ServerLlmResult {
  return resolveServerLlm(envLike());
}
