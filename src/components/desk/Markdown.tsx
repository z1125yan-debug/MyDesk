"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// 聊天气泡内的轻量 Markdown 渲染：加粗 / 标题 / 列表 / 表格 / 代码块 / 分隔线
export default function Markdown({ content }: { content: string }) {
  return (
    <div
      className="space-y-2 [&_a]:text-sky-300 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-sky-500/40 [&_blockquote]:pl-2 [&_blockquote]:text-muted-foreground [&_code]:rounded [&_code]:bg-accent [&_code]:px-1 [&_h1]:text-[15px] [&_h1]:font-bold [&_h2]:text-[14px] [&_h2]:font-bold [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-sky-300 [&_hr]:border-border [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-accent/60 [&_pre]:p-2 [&_strong]:font-semibold [&_strong]:text-foreground [&_table]:w-full [&_table]:text-[12px] [&_tbody_tr]:border-b [&_tbody_tr]:border-border/50 [&_td]:px-1.5 [&_td]:py-1 [&_th]:border-b [&_th]:border-border [&_th]:px-1.5 [&_th]:py-1 [&_th]:text-left [&_ul]:list-disc [&_ul]:pl-4"
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
