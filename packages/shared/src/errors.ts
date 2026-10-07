/** Typed error hierarchy so callers can branch without string matching. */

export class AgentOsError extends Error {
  readonly status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

export class NotFoundError extends AgentOsError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, 404);
  }
}

export class ValidationError extends AgentOsError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class ConflictError extends AgentOsError {
  constructor(message: string) {
    super(message, 409);
  }
}

/** Raised when the policy engine denies a tool call. Never bypassed by prompts. */
export class PolicyDeniedError extends AgentOsError {
  constructor(
    readonly tool: string,
    readonly reason: string,
    readonly rule: string | null,
  ) {
    super(`tool "${tool}" denied by policy: ${reason}`, 403);
  }
}

export class LimitExceededError extends AgentOsError {
  constructor(which: string, limit: number | string) {
    super(`limit exceeded: ${which} (${limit})`, 429);
  }
}

export class ProviderError extends AgentOsError {
  constructor(provider: string, message: string) {
    super(`provider "${provider}" failed: ${message}`, 502);
  }
}

export class SandboxError extends AgentOsError {
  constructor(message: string) {
    super(message, 400);
  }
}

export function isAgentOsError(e: unknown): e is AgentOsError {
  return e instanceof AgentOsError;
}
