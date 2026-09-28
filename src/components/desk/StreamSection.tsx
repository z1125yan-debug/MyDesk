// StreamSection：稳智风格的分析分区卡
// icon + 标题 + 状态徽章 + 内容区，一段就是一件事
// 颜色 / 圆角 / 间距都从稳智 AiMatrixHome-D20s36eF.css 抄下来

type Tone = "primary" | "info" | "success" | "warning" | "danger" | "default";
type Status = "active" | "running" | "loading" | "done" | "ready";

const TONE_BG: Record<Tone, string> = {
  primary: "border-l-sky-400/50 bg-sky-500/5",
  info:    "border-l-sky-400/50 bg-sky-500/5",
  success: "border-l-emerald-400/40 bg-emerald-500/5",
  warning: "border-l-amber-400/40 bg-amber-500/5",
  danger:  "border-l-red-400/40 bg-red-500/5",
  default: "border-l-border bg-muted/5",
};

const STATUS_COLOR: Record<Status, string> = {
  active:  "text-sky-400",
  running: "text-sky-400",
  loading: "text-sky-400",
  done:    "text-emerald-400",
  ready:   "text-emerald-400",
};

const STATUS_TEXT: Record<Status, string> = {
  active:  "进行中",
  running: "进行中",
  loading: "加载中",
  done:    "已完成",
  ready:   "已完成",
};

export default function StreamSection({
  icon,
  title,
  tone = "default",
  status,
  children,
  hint,
}: {
  icon?: React.ReactNode;
  title: string;
  tone?: Tone;
  status?: Status;
  children?: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className={`rounded-lg border border-l-2 border-border ${TONE_BG[tone]} p-3`}>
      <div className="mb-2 flex items-center gap-2">
        {icon && <span className="text-lg leading-none">{icon}</span>}
        <span className="text-sm font-semibold">{title}</span>
        {hint && <span className="text-[12px] text-muted-foreground">· {hint}</span>}
        {status && (
          <span
            className={`ml-auto rounded-md px-1.5 py-0.5 text-[12px] ${STATUS_COLOR[status]} bg-foreground/5`}
          >
            {STATUS_TEXT[status]}
          </span>
        )}
      </div>
      {children && <div className="text-[14px] leading-relaxed text-muted-foreground">{children}</div>}
    </div>
  );
}
