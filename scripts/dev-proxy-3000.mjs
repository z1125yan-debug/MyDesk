// 3014 → 3000 TCP 转发（2026-09-29）：dev 主服务挂 3000（用户要求主要留 3000），
// 这个纯 TCP 透传让老地址 3014 也能用——HTTP 和 HMR WebSocket 都是原样字节转发，无解析无改动。
// 用法：node scripts/dev-proxy-3000.mjs  （挂在后台即可）
import net from "node:net";

const LISTEN = 3014, TARGET_PORT = 3000, TARGET_HOST = "127.0.0.1";

net.createServer((client) => {
  const up = net.connect(TARGET_PORT, TARGET_HOST);
  client.pipe(up); up.pipe(client);
  const bye = () => { client.destroy(); up.destroy(); };
  client.on("error", bye); up.on("error", bye);
}).listen(LISTEN, () => console.log(`[dev-proxy] ${LISTEN} → ${TARGET_HOST}:${TARGET_PORT} 透传已启动`));
