import type { FastifyReply } from 'fastify';
import type { BusEvent, EventBus } from '@agentos/shared';

export const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const;

function write(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Opens an SSE channel filtered from the in-process event bus. Emits a
 * `connected` heartbeat immediately, then matching bus events, and cleans up
 * the subscription when the client disconnects.
 */
export function openSse(
  reply: FastifyReply,
  bus: EventBus,
  filter?: (e: BusEvent) => boolean,
): void {
  reply.raw.writeHead(200, SSE_HEADERS);
  write(reply, 'connected', { ts: Date.now() });

  const heartbeat = setInterval(() => {
    reply.raw.write(`: ping\n\n`);
  }, 15_000);

  const off = bus.subscribe((event) => {
    if (filter && !filter(event)) return;
    write(reply, event.type, event);
  });

  const cleanup = (): void => {
    clearInterval(heartbeat);
    off();
    reply.raw.end();
  };
  reply.raw.on('close', cleanup);
}
