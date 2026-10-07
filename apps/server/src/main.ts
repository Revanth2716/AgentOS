import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { buildServer } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = createContext(config);
  const app = await buildServer(ctx);

  const shutdown = async (signal: string): Promise<void> => {
    ctx.logger.info({ signal }, 'shutting down');
    try {
      await app.close();
      await ctx.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
  const url = `http://${config.host}:${config.port}`;
  ctx.logger.info(
    { url, demo: config.demoMode, seeded: ctx.seedSummary },
    `AgentOS control plane ready — dashboard ${url}, API ${url}/api/v1, metrics ${url}/metrics`,
  );
  if (config.logPretty) {
    process.stdout.write(
      `\n  AgentOS — Local-First AI Agent Control Plane\n` +
        `  Dashboard : ${url}\n` +
        `  API       : ${url}/api/v1\n` +
        `  Metrics   : ${url}/metrics\n` +
        `  Demo mode : ${config.demoMode ? 'ON (zero-cost, offline)' : 'OFF'}\n\n`,
    );
  }
}

main().catch((e) => {
  process.stderr.write(`AgentOS failed to start: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
