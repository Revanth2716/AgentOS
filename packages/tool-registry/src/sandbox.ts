import fs from 'node:fs';
import path from 'node:path';
import { SandboxError } from '@agentos/shared';

/**
 * Resolves `userPath` inside the sandbox `root`, rejecting:
 * - absolute paths that escape the root
 * - `..` traversal
 * - symlinks pointing outside the root (deepest existing ancestor is checked)
 */
export function resolveInSandbox(root: string, userPath: string): string {
  if (typeof userPath !== 'string' || userPath.includes('\0')) {
    throw new SandboxError('invalid path');
  }
  const rootAbs = path.resolve(root);
  const resolved = path.resolve(rootAbs, userPath);
  if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
    throw new SandboxError(`path escapes workspace sandbox: ${userPath}`);
  }
  // Symlink escape check: resolve the real path of the deepest existing ancestor.
  let probe = resolved;
  while (probe !== rootAbs && !fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (fs.existsSync(probe)) {
    const real = fs.realpathSync(probe);
    if (real !== rootAbs && !real.startsWith(rootAbs + path.sep)) {
      throw new SandboxError(`path resolves outside workspace sandbox: ${userPath}`);
    }
  }
  return resolved;
}

export function ensureDirSandboxed(root: string, dir: string): string {
  const resolved = resolveInSandbox(root, dir);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

/** Sanitizes a bare filename — rejects (never rewrites) directory or traversal input. */
export function sanitizeFilename(name: string): string {
  const trimmed = name.trim();
  if (/[\\/]/.test(trimmed) || trimmed.includes('..')) {
    throw new SandboxError(`filename must not contain path separators or '..': ${name}`);
  }
  const base = path.basename(trimmed);
  if (!base || base === '.' || base === '..' || /[\\/:*?"<>|]/.test(base)) {
    throw new SandboxError(`invalid filename: ${name}`);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(base)) {
    throw new SandboxError(`filename may only contain letters, digits, dot, dash, underscore: ${name}`);
  }
  return base;
}
