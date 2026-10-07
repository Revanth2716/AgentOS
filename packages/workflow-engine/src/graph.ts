import { ValidationError, type WorkflowSpec } from '@agentos/shared';

export interface GraphValidation {
  /** Nodes with no incoming edges (entry points). */
  entry: string[];
  /** Nodes with no outgoing edges (exit points). */
  exit: string[];
  /** Topologically sorted node ids (throws on cycle). */
  order: string[];
}

/** Validates a workflow graph: references, duplicates, cycles. Throws ValidationError. */
export function validateGraph(spec: WorkflowSpec): GraphValidation {
  if (spec.nodes.length === 0) throw new ValidationError('workflow has no nodes');
  const ids = new Set<string>();
  for (const n of spec.nodes) {
    if (ids.has(n.id)) throw new ValidationError(`duplicate node id: ${n.id}`);
    ids.add(n.id);
    if (n.type === 'agent' && !n.agentId) {
      throw new ValidationError(`agent node "${n.id}" is missing agentId`);
    }
  }
  const indegree = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const id of ids) {
    indegree.set(id, 0);
    out.set(id, []);
  }
  for (const e of spec.edges) {
    if (!ids.has(e.from)) throw new ValidationError(`edge references unknown node: ${e.from}`);
    if (!ids.has(e.to)) throw new ValidationError(`edge references unknown node: ${e.to}`);
    if (e.from === e.to) throw new ValidationError(`self-edge not allowed: ${e.from}`);
    (out.get(e.from) as string[]).push(e.to);
    indegree.set(e.to, (indegree.get(e.to) as number) + 1);
  }

  // Kahn's algorithm for topo order + cycle detection.
  const entry = [...ids].filter((id) => (indegree.get(id) as number) === 0).sort();
  const order: string[] = [];
  const queue = [...entry];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const next of out.get(id) as string[]) {
      const d = (indegree.get(next) as number) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (order.length !== ids.size) {
    const cyclic = [...ids].filter((id) => !order.includes(id));
    throw new ValidationError(`workflow graph contains a cycle involving: ${cyclic.join(', ')}`);
  }

  return {
    entry,
    exit: [...ids].filter((id) => (out.get(id) as string[]).length === 0).sort(),
    order,
  };
}

/** Direct predecessors of each node. */
export function predecessors(spec: WorkflowSpec): Map<string, string[]> {
  const pred = new Map<string, string[]>();
  for (const n of spec.nodes) pred.set(n.id, []);
  for (const e of spec.edges) pred.get(e.to)?.push(e.from);
  return pred;
}

/**
 * Replaces {{nodeId.output}} placeholders with the upstream node's output.
 * Unknown placeholders throw — a mis-wired template must fail loudly.
 */
export function interpolate(template: string, outputs: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_-]+)\.output\s*\}\}/g, (_m, id: string) => {
    if (!(id in outputs)) {
      throw new ValidationError(`template references unknown upstream node: ${id}`);
    }
    const v = outputs[id];
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  });
}
