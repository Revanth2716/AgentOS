import type { EventBus, BusEvent, BusListener } from '@agentos/shared';

/**
 * Default in-process event bus. All runtime/workflow/eval events flow through
 * this seam; a future NATS adapter implements the same EventBus interface.
 */
export class InProcessEventBus implements EventBus {
  private readonly listeners = new Set<BusListener>();

  publish(event: BusEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never break the publisher.
      }
    }
  }

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
