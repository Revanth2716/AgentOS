import path from 'node:path';

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  dbFile: string;
  workspaceDir: string;
  artifactsDir: string;
  demoMode: boolean;
  logPretty: boolean;
  ollama: { url: string; model: string };
  openai: { baseUrl: string; apiKey: string; model: string };
  priceOverrides?: string;
  fetchAllowHosts: string[];
  webDist: string;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, rootDir = process.cwd()): AppConfig {
  const dataDir = path.resolve(rootDir, env.AGENTOS_DATA_DIR ?? '.agentos');
  return {
    port: Number(env.AGENTOS_PORT ?? 8787),
    host: env.AGENTOS_HOST ?? '127.0.0.1',
    dataDir,
    dbFile: path.join(dataDir, 'agentos.db'),
    workspaceDir: path.join(dataDir, 'workspace'),
    artifactsDir: path.join(dataDir, 'artifacts'),
    demoMode: bool(env.AGENTOS_DEMO_MODE, true),
    logPretty: bool(env.AGENTOS_LOG_PRETTY, false),
    ollama: {
      url: env.AGENTOS_OLLAMA_URL ?? 'http://127.0.0.1:11434',
      model: env.AGENTOS_OLLAMA_MODEL ?? 'llama3.2',
    },
    openai: {
      baseUrl: env.AGENTOS_OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: env.AGENTOS_OPENAI_API_KEY ?? '',
      model: env.AGENTOS_OPENAI_MODEL ?? 'gpt-4o-mini',
    },
    priceOverrides: env.AGENTOS_PRICE_OVERRIDES || undefined,
    fetchAllowHosts: (env.AGENTOS_FETCH_ALLOW_HOSTS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    webDist: path.resolve(rootDir, 'apps/web/dist'),
  };
}
