// 日报 PDF · 落盘到 ~/workspace/your_files/（交付时只贴附件，不贴正文）。
//
// 文件名（用户定）：MyDesk日报-YYYY-MM-DD早报.pdf / 午盘.pdf / 晚报.pdf / 周报.pdf
//   注意午报文件用“午盘”不是“午报”，与第一版午报文件命名一致。
// 本文件只做“生成 + 写盘”，不改日报内容口径；调用方（调度器 / 补发接口）
// 在日报生成成功后 best-effort 调用，PDF 失败不影响日报本身（调用方捕获）。

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ReportSlot } from "./three-daily-reports-core";

export type DailyPdfSlot = ReportSlot | "weekly";

const SLOT_FILE_LABEL: Record<DailyPdfSlot, string> = {
  morning: "早报",
  noon: "午盘",
  evening: "晚报",
  weekly: "周报",
};

/** MyDesk日报-2026-10-16晚报.pdf */
export function dailyPdfFileName(slot: DailyPdfSlot, date: string): string {
  return `MyDesk日报-${date}${SLOT_FILE_LABEL[slot]}.pdf`;
}

/** ~/workspace/your_files/（HOME 为准；HOME 未设时按仓库根目录的上一级回退） */
export function yourFilesDir(): string {
  if (process.env.HOME) return path.join(process.env.HOME, "workspace", "your_files");
  return path.resolve(process.cwd(), "..", "your_files");
}

/**
 * 生成指定日报的 PDF 并写到 ~/workspace/your_files/，返回完整路径。
 * 当天份：与日报正文同源的结构化数据现拉；周报：读归档/现算（与 PDF 接口同口径）。
 */
export async function writeDailyPdfFile(slot: DailyPdfSlot, date: string): Promise<string> {
  const { fetchDailyPdfBuffer, fetchWeeklyPdfBuffer } = await import("./daily-report-pdf");
  const buf = slot === "weekly" ? await fetchWeeklyPdfBuffer(date) : await fetchDailyPdfBuffer(slot, date);
  const dir = yourFilesDir();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, dailyPdfFileName(slot, date));
  await fs.writeFile(file, buf);
  return file;
}
