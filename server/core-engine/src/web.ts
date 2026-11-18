import { Conversation } from './core.ts';
import { loadConfig } from './config.ts';
import { createWebServer } from './web-server.ts';

const port = Number(process.env.HEZUO_CORE_WEB_PORT || 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('HEZUO_CORE_WEB_PORT must be an integer between 1 and 65535');
  process.exit(1);
}

try {
  const config = loadConfig();
  const app = createWebServer(config, onScreenshot => new Conversation(config, undefined, onScreenshot), port);
  app.server.on('error', () => {
    console.error('无法启动本机网页服务；请检查端口是否被占用。');
    process.exitCode = 1;
  });
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`HezuoBot Core: http://127.0.0.1:${port}`);
    console.log('仅本机访问；尚未创建 Conversation 或启动浏览器。Ctrl+C 关闭会话与服务。');
  });
  let exiting = false;
  const stop = async () => {
    if (exiting) return;
    exiting = true;
    // Stop accepting new sockets, but let shutdown abort the active turn before
    // waiting for existing requests to drain.
    app.server.close();
    try { await app.shutdown(); }
    catch { console.error('会话关闭失败，请确认专属浏览器已退出。'); process.exitCode = 1; }
    finally { app.server.closeAllConnections(); }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch {
  // Do not echo configuration values, which may contain API credentials.
  console.error('网页服务配置无效，请检查 .env 中已有的 HEZUO_CORE 模型及权限配置。');
  process.exitCode = 1;
}
