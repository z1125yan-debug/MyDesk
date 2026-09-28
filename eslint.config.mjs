import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  rules: {
    // TypeScript rules
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/prefer-as-const": "off",
    "@typescript-eslint/no-unused-disable-directive": "off",
    
    // React rules
    "react-hooks/exhaustive-deps": "off",
    "react-hooks/purity": "off",

    // R21 降级说明（不要悄悄改回 error，先看这段）：
    // `react-hooks/set-state-in-effect` 是 React Compiler 的规则，它禁止「在 effect 的同步路径里 setState」。
    // 本项目 30+ 个页面都是同一个标准模式：useEffect 里先 setBusy(true) 再发起异步取数 ——
    // 而 React 官方至今没有给出能替代它的、无额外成本的取数方案（useSyncExternalStore 要外部 store，
    // 框架级 data fetching 要换路由）。逐个改只有两条路：要么 setTimeout(0) 绕过（自欺欺人，还多一层微任务），
    // 要么把 setState 挪进 async IIFE（只换来「规则看不见」，渲染次数完全一样）。
    // 所以这里降级为 warn：**不再让 40 多条红把真正的新违规淹没**，但位置仍然列得出来。
    // 「新增不许再犯」由 tests/quant/p16-lint-baseline.test.ts 钉住数量来兜底（超了就红）。
    "react-hooks/set-state-in-effect": "warn",
    // 同上：这两条是 Compiler 的推测性规则，在没开 React Compiler 编译的项目里属于噪音
    "react-hooks/immutability": "warn",
    "react-hooks/preserve-manual-memoization": "warn",
    "react/no-unescaped-entities": "off",
    "react/display-name": "off",
    "react/prop-types": "off",
    "react-compiler/react-compiler": "off",
    
    // Next.js rules
    "@next/next/no-img-element": "off",
    "@next/next/no-html-link-for-pages": "off",
    
    // General JavaScript rules
    "prefer-const": "off",
    "no-unused-vars": "off",
    "no-console": "off",
    "no-debugger": "off",
    "no-empty": "off",
    "no-irregular-whitespace": "off",
    "no-case-declarations": "off",
    "no-fallthrough": "off",
    "no-mixed-spaces-and-tabs": "off",
    "no-redeclare": "off",
    "no-undef": "off",
    "no-unreachable": "off",
    "no-useless-escape": "off",
  },
}, {
  // .stale-next/ 是「移走但先不删」的旧 .next 编译产物（Windows 上 safe-delete 守卫生效时
  // 只能 rename 不能 rm），里面全是已编译 JS，必须排除——否则 lint 会去扫几万行产物。
  // src/components/ui/** 与 src/hooks/** 是 shadcn/ui 一类的第三方模板代码：
  // 上游怎么写我们就怎么用，改它是给未来升级埋冲突，lint 它只会产出无法修复的噪音。
  ignores: [
    "node_modules/**", ".next/**", ".stale-next/**", "out/**", "build/**",
    "next-env.d.ts", "examples/**", "skills",
    "src/components/ui/**", "src/hooks/**",
  ]
}];

export default eslintConfig;
