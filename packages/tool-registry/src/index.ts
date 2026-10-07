export * from './types.js';
export { ToolRegistry, type ToolPermissionCheck } from './registry.js';
export { resolveInSandbox, ensureDirSandboxed, sanitizeFilename } from './sandbox.js';
export { calculatorTool } from './tools/calculator.js';
export { fsReadTool, fsWriteTool, fsListTool } from './tools/fs.js';
export { httpFetchTool, assertPublicUrl, type HttpFetchOptions } from './tools/http.js';
export { corpusSearchTool, corpusReadTool, type CorpusService } from './tools/corpus.js';
export { reportWriteTool } from './tools/report.js';

import type { ToolDefinition } from './types.js';
import { calculatorTool } from './tools/calculator.js';
import { fsReadTool, fsWriteTool, fsListTool } from './tools/fs.js';
import { httpFetchTool, type HttpFetchOptions } from './tools/http.js';
import { corpusSearchTool, corpusReadTool, type CorpusService } from './tools/corpus.js';
import { reportWriteTool } from './tools/report.js';

export interface BuiltinToolOptions extends HttpFetchOptions {
  corpus?: CorpusService;
}

/** Registers every builtin tool and returns them. */
export function builtinTools(opts: BuiltinToolOptions = {}): ToolDefinition[] {
  const tools: ToolDefinition[] = [calculatorTool(), fsReadTool(), fsWriteTool(), fsListTool(), httpFetchTool(opts)];
  if (opts.corpus) {
    tools.push(corpusSearchTool(opts.corpus), corpusReadTool(opts.corpus));
  }
  tools.push(reportWriteTool());
  return tools;
}
