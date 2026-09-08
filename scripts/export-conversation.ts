/**
 * Renders the Claude Code session transcript (JSONL) for this project into a
 * single Markdown file, `docs/ai-conversation.md`, for inclusion in the
 * submission (the challenge asks for the AI conversation).
 *
 *   npm run export:conversation
 *   npm run export:conversation -- <path-to-session.jsonl> <out.md>
 *
 * What it keeps: every human message and every assistant prose reply, verbatim.
 * Tool calls are collapsed to a one-line trace (name + the salient argument).
 * What it drops: assistant "thinking" blocks, raw tool output, and the editor /
 * session bookkeeping lines — none of which are "the conversation".
 *
 * Re-run this as the LAST step before packaging: the transcript keeps growing
 * until the session ends.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PROJECT_SLUG = 'E--projects-TypeScript-EnvChaos-Coding-Challenge';
const DEFAULT_OUT = path.join('docs', 'ai-conversation.md');

interface ContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly thinking?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
}

interface TranscriptLine {
  readonly type?: string;
  readonly isSidechain?: boolean;
  readonly message?: { readonly role?: string; readonly content?: string | ContentBlock[] };
}

function findDefaultTranscript(): string {
  const dir = path.join(os.homedir(), '.claude', 'projects', PROJECT_SLUG);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) {
    throw new Error(`no .jsonl transcript found in ${dir}`);
  }
  return path.join(dir, files[0]!.f);
}

/** Injected context and slash-command wrappers are not something the human typed. */
function cleanUserText(raw: string): string {
  return raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .trim();
}

function firstLine(value: unknown, max = 160): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** One-line summary of a tool call: the name plus its most informative argument. */
function toolLine(name: string, input: Record<string, unknown>): string {
  const rel = (p: unknown): string =>
    String(p ?? '')
      .replace(/\\/g, '/')
      .replace(/^.*\/EnvChaos Coding Challenge\//, '');
  let detail = '';
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      detail = firstLine(input.command);
      break;
    case 'Read':
    case 'Write':
      detail = rel(input.file_path);
      break;
    case 'Edit':
      detail = rel(input.file_path);
      break;
    case 'Glob':
    case 'Grep':
      detail = firstLine(input.pattern) + (input.path ? ` in ${rel(input.path)}` : '');
      break;
    case 'Skill':
      detail = String(input.skill ?? '');
      break;
    case 'Task':
    case 'Agent':
      detail = firstLine(input.description ?? input.prompt);
      break;
    default: {
      const keys = Object.keys(input);
      detail = keys.length > 0 ? firstLine(JSON.stringify(input)) : '';
    }
  }
  return detail ? `\`${name}\` — ${detail}` : `\`${name}\``;
}

function main(): void {
  const [, , inArg, outArg] = process.argv;
  const inPath = inArg ?? findDefaultTranscript();
  const outPath = outArg ?? DEFAULT_OUT;

  const lines = fs.readFileSync(inPath, 'utf8').split('\n').filter(Boolean);
  const out: string[] = [
    '# AI Development Conversation',
    '',
    'The full Claude Code session that produced this solution, rendered from the',
    'session transcript by `scripts/export-conversation.ts`. Human messages and',
    'assistant replies are verbatim; tool calls are collapsed to a one-line trace;',
    'assistant "thinking" and raw tool output are omitted.',
    '',
    '---',
    '',
  ];

  let lastRole: 'user' | 'assistant' | null = null;
  let userCount = 0;
  let assistantCount = 0;
  let toolCount = 0;

  const emitHeader = (role: 'user' | 'assistant'): void => {
    if (lastRole !== role) {
      out.push('', `## ${role === 'user' ? 'User' : 'Assistant'}`, '');
      lastRole = role;
    }
  };

  for (const line of lines) {
    let parsed: TranscriptLine;
    try {
      parsed = JSON.parse(line) as TranscriptLine;
    } catch {
      continue;
    }
    if (parsed.isSidechain || (parsed.type !== 'user' && parsed.type !== 'assistant')) {
      continue;
    }
    const content = parsed.message?.content;

    if (parsed.type === 'user' && typeof content === 'string') {
      const text = cleanUserText(content);
      if (text === '') {
        continue; // a tool-result carrier or pure injected context
      }
      emitHeader('user');
      out.push(text, '');
      userCount += 1;
      continue;
    }

    if (parsed.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text?.trim()) {
          emitHeader('assistant');
          out.push(block.text.trim(), '');
          assistantCount += 1;
        } else if (block.type === 'tool_use' && block.name) {
          emitHeader('assistant');
          out.push(`- 🔧 ${toolLine(block.name, block.input ?? {})}`);
          toolCount += 1;
        }
      }
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`, 'utf8');
  process.stdout.write(
    `wrote ${outPath} — ${userCount} user messages, ${assistantCount} assistant replies, ` +
      `${toolCount} tool calls (from ${path.basename(inPath)})\n`,
  );
}

main();
