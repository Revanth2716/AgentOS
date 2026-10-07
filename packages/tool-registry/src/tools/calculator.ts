import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

const InputSchema = z.object({
  expression: z.string().min(1).max(200),
});

type Token = { t: 'num'; v: number } | { t: 'op'; v: string } | { t: 'paren'; v: '(' | ')' };

const PRECEDENCE: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ') {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j] as string)) j++;
      const num = Number(src.slice(i, j));
      if (!Number.isFinite(num)) throw new Error(`invalid number at ${i}`);
      tokens.push({ t: 'num', v: num });
      i = j;
      continue;
    }
    if ('+-*/%^'.includes(ch)) {
      tokens.push({ t: 'op', v: ch });
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ t: 'paren', v: ch });
      i++;
      continue;
    }
    throw new Error(`unexpected character "${ch}" at ${i}`);
  }
  return tokens;
}

/** Shunting-yard to RPN, then evaluate. Unary minus becomes (0 - x). */
function evaluate(tokens: Token[]): number {
  const output: Token[] = [];
  const ops: Token[] = [];
  let prevWasValue = false;
  for (const tok of tokens) {
    if (tok.t === 'num') {
      output.push(tok);
      prevWasValue = true;
    } else if (tok.t === 'op') {
      // Unary minus/plus: value-expected position.
      if (!prevWasValue && (tok.v === '-' || tok.v === '+')) {
        output.push({ t: 'num', v: 0 });
      }
      while (
        ops.length > 0 &&
        ops[ops.length - 1]!.t === 'op' &&
        PRECEDENCE[(ops[ops.length - 1] as { v: string }).v] >= PRECEDENCE[tok.v] &&
        tok.v !== '^' // right-associative
      ) {
        output.push(ops.pop() as Token);
      }
      ops.push(tok);
      prevWasValue = false;
    } else if (tok.v === '(') {
      ops.push(tok);
      prevWasValue = false;
    } else {
      while (ops.length > 0 && !(ops[ops.length - 1]!.t === 'paren')) {
        output.push(ops.pop() as Token);
      }
      if (ops.length === 0) throw new Error('unbalanced parentheses');
      ops.pop();
      prevWasValue = true;
    }
  }
  while (ops.length > 0) {
    const op = ops.pop() as Token;
    if (op.t === 'paren') throw new Error('unbalanced parentheses');
    output.push(op);
  }
  const stack: number[] = [];
  for (const tok of output) {
    if (tok.t === 'num') stack.push(tok.v);
    else {
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) throw new Error('malformed expression');
      switch (tok.v) {
        case '+': stack.push(a + b); break;
        case '-': stack.push(a - b); break;
        case '*': stack.push(a * b); break;
        case '/':
          if (b === 0) throw new Error('division by zero');
          stack.push(a / b);
          break;
        case '%':
          if (b === 0) throw new Error('division by zero');
          stack.push(a % b);
          break;
        case '^': stack.push(Math.pow(a, b)); break;
        default: throw new Error(`unknown operator ${tok.v}`);
      }
    }
  }
  if (stack.length !== 1) throw new Error('malformed expression');
  return stack[0] as number;
}

export function calculatorTool(): ToolDefinition {
  return {
    name: 'calculator',
    description: 'Evaluate an arithmetic expression (+ - * / % ^, parentheses). No side effects.',
    kind: 'compute',
    riskLevel: 'low',
    permissions: [],
    inputSchema: InputSchema,
    inputSchemaJson: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'arithmetic expression, e.g. (2+3)*4' } },
      required: ['expression'],
    },
    timeoutMs: 5_000,
    maxRetries: 0,
    sampleInput: () => ({ expression: '(2+3)*4' }),
    async handler(raw) {
      const parsed = InputSchema.safeParse(raw);
      if (!parsed.success) {
        return { ok: false, error: `invalid input: ${parsed.error.issues[0]?.message}`, errorKind: 'validation', output: '' };
      }
      try {
        const value = evaluate(tokenize(parsed.data.expression));
        const rounded = Math.round(value * 1e10) / 1e10;
        return {
          ok: true,
          output: `${parsed.data.expression} = ${rounded}`,
          data: { expression: parsed.data.expression, value: rounded },
        };
      } catch (e) {
        return {
          ok: false,
          error: `evaluation failed: ${(e as Error).message}`,
          errorKind: 'validation',
          output: '',
        };
      }
    },
  };
}
