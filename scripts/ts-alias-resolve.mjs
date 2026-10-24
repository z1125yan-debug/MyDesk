// 解析钩子（配合 ts-alias-register.mjs 使用）：让 plain Node 跑通 TS 源码的 import 风格。
// 处理两种 TS 惯用写法，Node ESM 默认解析不了：
//   ① `@/*` 别名（tsconfig paths）→ `<repo>/src/*`
//   ② 相对 import 省略扩展名（`./mcp-http-client`）→ 依次试 .ts / .tsx / /index.ts
// 其余（node:、裸包名如 undici、带扩展名的）全部交给默认解析。不做 load，不改源码。
// 注意：本文件是 .mjs 纯 JS（钩子文件加载时不做类型剥离），不要写 TS 类型注解。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../src");

function tryCandidates(base) {
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // 不存在，试下一个
    }
  }
  return null;
}

// 钩子短路返回时不要带 format：Node 会按 .ts 扩展名自行走类型剥离；
// 带 format: "typescript" 反而报 ERR_UNKNOWN_MODULE_FORMAT。
// 另：本钩子解析出的链可能含参数属性等非可擦除 TS 语法，必须用
// --experimental-transform-types 运行（光 --experimental-strip-types 不够）。

const HAS_EXT = /\.[a-zA-Z0-9]+$/;

export async function resolve(specifier, context, nextResolve) {
  if (typeof specifier === "string") {
    if (specifier.startsWith("@/")) {
      const hit = tryCandidates(path.join(SRC_DIR, specifier.slice(2)));
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
      return nextResolve(specifier, context);
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !HAS_EXT.test(specifier) &&
      context.parentURL
    ) {
      try {
        const parentDir = path.dirname(fileURLToPath(context.parentURL));
        const hit = tryCandidates(path.resolve(parentDir, specifier));
        if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
      } catch {
        // parentURL 不是文件 URL 等，交给默认解析
      }
    }
  }
  return nextResolve(specifier, context);
}

// load 钩子：`server-only` 包在 plain Node 下会直接 throw（它靠 Next 编译器在服务端组件里特殊处理）。
// 脚本里它只是标记“仅服务端”，直接返回空模块即可，不影响业务逻辑。
export async function load(url, context, nextLoad) {
  if (typeof url === "string" && url.includes("/node_modules/server-only/")) {
    return { format: "module", source: "", shortCircuit: true };
  }
  return nextLoad(url, context);
}
