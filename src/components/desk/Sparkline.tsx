"use client";

// 迷你走势线（自绘 SVG，无第三方图表依赖）
export default function Sparkline({
  data, up, width = 120, height = 36,
}: {
  data: number[];
  up: boolean;
  width?: number;
  height?: number;
}) {
  if (!data.length) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const stepX = width / (data.length - 1 || 1);
  const pts = data.map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / span) * (height - 4) - 2).toFixed(1)}`);
  const color = up ? "#fb7185" : "#34d399";
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <polyline
        points={`0,${height} ${pts.join(" ")} ${width},${height}`}
        fill={color}
        opacity="0.10"
        stroke="none"
      />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}
