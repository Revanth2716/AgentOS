import { ConflictError } from '@agentos/shared';
import type { ToolDefinition } from './types.js';

export interface ToolPermissionCheck {
  ok: boolean;
  missing: string[];
}

/**
 * Central registry of executable tools. Registration validates shape; the
 * runtime resolves tools for an agent and enforces permissions + policies
 * before any handler executes.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): void {
    if (this.tools.has(def.name)) {
      throw new ConflictError(`tool already registered: ${def.name}`);
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(def.name)) {
      throw new ConflictError(`invalid tool name: ${def.name}`);
    }
    this.tools.set(def.name, def);
  }

  registerOrReplace(def: ToolDefinition): void {
    this.tools.set(def.name, def);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Does the agent hold every permission the tool requires? */
  checkPermissions(agentPermissions: readonly string[], tool: ToolDefinition): ToolPermissionCheck {
    const held = new Set(agentPermissions);
    const missing = tool.permissions.filter((p) => !held.has(p));
    return { ok: missing.length === 0, missing };
  }

  /** Tools an agent may see: declared in its tool list, registered, and permission-satisfied. */
  resolveForAgent(
    agent: { tools: readonly string[]; permissions: readonly string[] },
  ): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const name of agent.tools) {
      const tool = this.tools.get(name);
      if (tool && this.checkPermissions(agent.permissions, tool).ok) out.push(tool);
    }
    return out;
  }
}
