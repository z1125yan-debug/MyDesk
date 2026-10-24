// Node 模块解析钩子：把 tsconfig 的 `@/*` 别名解析到 `./src/*`。
// 用法（脚本运行时）：
//   node --import ./scripts/ts-alias-register.mjs --experimental-strip-types scripts/<script>.ts
// 只做解析，不改任何业务逻辑。纯 Node，无第三方依赖。
import { register } from "node:module";

register("./ts-alias-resolve.mjs", import.meta.url);
