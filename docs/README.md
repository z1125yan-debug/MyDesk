# 文档索引（docs/）

本目录集中存放项目的设计 / 规划 / 对标文档。仓库根目录只保留可运行工程文件、配置与入口脚本（`启动.bat`）。

## plans/ — 方案与规划
- `P34-forecast-regime-plan.md` — 预测制度（P34）方案
- `forecasting-direction-unlock-plan.md` — 类型 B 方向概率预测（训练 / 回测数据来源）
- `type-B-forecast-implementation-plan.md` — 类型 B 预测实现方案
- `market-top-warning-plan.md` — 大盘 / 板块见顶预警
- `sector-top-risk-detector-plan.md` / `sector-top-risk-ui-plan.md` — 板块见顶风险检测与 UI
- `serenity-integration-plan.md` / `serenity-adaptation-plan.md` — serenity 技能集成与适配
- `trio-integration-plan.md` / `trio-plain-rollout-plan.md` — trio 集成与灰度
- `wechat-ai-bot-plan.md` — 微信 AI bot
- `QUANT_LAB_PHASE0.md` / `QUANT_LAB_PHASES.md` — 量化实验室分阶段

## wenzhi/ — 稳智对齐（默认智能助手 v2）
- `wenzhi-deep-comparison.md` — 深度对标
- `wenzhi-full-comparison.md` — 全量对标
- `wenzhi-comparison-report.md` — 对比报告
- `wenzhi-gap-analysis.md` — 差距分析
- `wenzhi-ai-output-spec.md` — AI 输出规范
- `wenzhi-theme-heat-panel.md` — 题材热度面板
- `wenzhi-final-audit-20260928.md` — 终审
- `wenzhi-c-phase2-closeout.md` — C 阶段二收口
- `wenzhi-c-p17 … p34` — C 阶段分条实现记录（意图 / SSE / 决策卡 / 错误码 / 任务 TTL 等）

## tasks/ — 任务书
- `P36-8分达标任务书.md`

## notes/ — 说明
- `使用说明.txt`
- `情绪分类策略选择.txt`

## 其他
- `worklog.md` — 开发日志（过程记录）

> 源码里对上述文档的引用均为**注释中的文件名**（非路径），移动后仍可读；工程构建不依赖这些文档。
