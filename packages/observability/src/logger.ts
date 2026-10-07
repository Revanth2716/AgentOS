import pino, { type Logger } from 'pino';
import { redactString } from '@agentos/shared';

export type { Logger };

/**
 * Structured JSON logging (pino) with credential redaction paths.
 * In dev (AGENTOS_LOG_PRETTY=true) output is human-readable; in CI/prod it is
 * machine-parseable JSON.
 */
export function createLogger(opts: { pretty?: boolean; level?: string } = {}): Logger {
  const level = opts.level ?? process.env.AGENTOS_LOG_LEVEL ?? 'info';
  if (opts.pretty) {
    return pino({
      level,
      formatters: {
        level: (label) => ({ level: label }),
      },
      hooks: {
        logMethod(args, method) {
          const safe = args.map((a) => (typeof a === 'string' ? redactString(a) : a));
          (method as (...rest: unknown[]) => void).apply(this, safe);
        },
      },
    });
  }
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.apiKey',
        '*.api_key',
        '*.token',
        '*.password',
        '*.secret',
      ],
      censor: '***REDACTED***',
    },
  });
}

/** Shared no-op logger for tests/tools that don't need logging. */
export const nullLogger: Logger = pino({ level: 'silent' });
