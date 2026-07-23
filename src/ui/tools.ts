// Local tool implementations for the Kompass UI agent loop (src/ui/server.ts).
// Node-only — never imported by the Worker. Tools are grouped per UI mode:
//   agentic  → bash / read_file / write_file / edit_file / list_files / search_files
//   research → web_search / web_fetch
//   slides   → web_search / web_fetch / create_presentation
// bash, write_file and edit_file are gated behind user approval in the UI
// unless auto-approve is enabled for the session.
import { exec } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolContext {
  workspace: string;
  outputDir: string;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  /** Set by create_presentation: browser-relative download URL. */
  downloadUrl?: string;
}

const MAX_OUTPUT = 30_000;

function clip(s: string, max = MAX_OUTPUT): string {
  return s.length > max ? s.slice(0, max) + `\n… [truncated ${s.length - max} chars]` : s;
}

function resolvePath(p: string, ctx: ToolContext): string {
  const expanded = p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  return isAbsolute(expanded) ? expanded : resolve(ctx.workspace, expanded);
}

// ---- agentic tools ----

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'venv',
  '.venv',
  'dist',
  'build',
  '__pycache__',
]);

function runBash(command: string, ctx: ToolContext): Promise<ToolResult> {
  return new Promise((resolveP) => {
    exec(
      command,
      { cwd: ctx.workspace, timeout: 120_000, maxBuffer: 10 * 1024 * 1024, shell: '/bin/zsh' },
      (err, stdout, stderr) => {
        const out = [stdout, stderr].filter(Boolean).join('\n--- stderr ---\n');
        if (err && err.killed)
          resolveP({ ok: false, output: clip(out) + '\n[timed out after 120s]' });
        else if (err) resolveP({ ok: false, output: clip(out) || String(err) });
        else resolveP({ ok: true, output: clip(out) || '(no output)' });
      },
    );
  });
}

function readFileTool(
  input: { path: string; offset?: number; limit?: number },
  ctx: ToolContext,
): ToolResult {
  const p = resolvePath(input.path, ctx);
  if (!existsSync(p)) return { ok: false, output: `file not found: ${p}` };
  const lines = readFileSync(p, 'utf8').split('\n');
  const start = Math.max(0, (input.offset ?? 1) - 1);
  const slice = lines.slice(start, start + (input.limit ?? 2000));
  const numbered = slice.map((l, i) => `${start + i + 1}\t${l}`).join('\n');
  return { ok: true, output: clip(numbered, 50_000) };
}

function writeFileTool(input: { path: string; content: string }, ctx: ToolContext): ToolResult {
  const p = resolvePath(input.path, ctx);
  mkdirSync(resolve(p, '..'), { recursive: true });
  writeFileSync(p, input.content);
  return { ok: true, output: `wrote ${input.content.length} chars to ${p}` };
}

function editFileTool(
  input: { path: string; old_string: string; new_string: string; replace_all?: boolean },
  ctx: ToolContext,
): ToolResult {
  const p = resolvePath(input.path, ctx);
  if (!existsSync(p)) return { ok: false, output: `file not found: ${p}` };
  const text = readFileSync(p, 'utf8');
  const count = text.split(input.old_string).length - 1;
  if (count === 0) return { ok: false, output: 'old_string not found in file' };
  if (count > 1 && !input.replace_all)
    return {
      ok: false,
      output: `old_string matches ${count} times — make it unique or set replace_all`,
    };
  const next = input.replace_all
    ? text.split(input.old_string).join(input.new_string)
    : text.replace(input.old_string, input.new_string);
  writeFileSync(p, next);
  return { ok: true, output: `replaced ${input.replace_all ? count : 1} occurrence(s) in ${p}` };
}

function listFilesTool(input: { path?: string }, ctx: ToolContext): ToolResult {
  const root = resolvePath(input.path ?? '.', ctx);
  if (!existsSync(root)) return { ok: false, output: `not found: ${root}` };
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= 500 || depth > 6) return;
    for (const name of readdirSync(dir).sort()) {
      if (out.length >= 500) return;
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const full = join(dir, name);
      const st = statSync(full);
      out.push(full.replace(root + '/', '') + (st.isDirectory() ? '/' : ''));
      if (st.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return { ok: true, output: clip(out.join('\n') || '(empty)') };
}

function searchFilesTool(input: { pattern: string; path?: string }, ctx: ToolContext): ToolResult {
  const root = resolvePath(input.path ?? '.', ctx);
  if (!existsSync(root)) return { ok: false, output: `not found: ${root}` };
  let re: RegExp;
  try {
    re = new RegExp(input.pattern);
  } catch {
    return { ok: false, output: `invalid regex: ${input.pattern}` };
  }
  const hits: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (hits.length >= 200 || depth > 6) return;
    for (const name of readdirSync(dir).sort()) {
      if (hits.length >= 200) return;
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full, depth + 1);
      else if (st.size < 1024 * 1024) {
        try {
          const lines = readFileSync(full, 'utf8').split('\n');
          lines.forEach((line, i) => {
            if (hits.length < 200 && re.test(line))
              hits.push(`${full.replace(root + '/', '')}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        } catch {
          /* binary/unreadable — skip */
        }
      }
    }
  };
  walk(root, 0);
  return { ok: true, output: clip(hits.join('\n') || 'no matches') };
}

// ---- research tools ----

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x?\d+;/g, ' ');
}

async function webSearchTool(input: { query: string }): Promise<ToolResult> {
  const res = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`,
    { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) KompassUI/1.0' } },
  );
  if (!res.ok) return { ok: false, output: `search failed: HTTP ${res.status}` };
  const html = await res.text();
  const results: string[] = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [...html.matchAll(snippetRe)].map((m) =>
    decodeEntities((m[1] ?? '').replace(/<[^>]+>/g, '')).trim(),
  );
  let i = 0;
  for (const m of html.matchAll(linkRe)) {
    if (results.length >= 8) break;
    let url = m[1] ?? '';
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg?.[1]) url = decodeURIComponent(uddg[1]);
    const title = decodeEntities((m[2] ?? '').replace(/<[^>]+>/g, '')).trim();
    results.push(`${results.length + 1}. ${title}\n   ${url}\n   ${snippets[i] ?? ''}`);
    i++;
  }
  return { ok: true, output: results.join('\n\n') || 'no results' };
}

async function webFetchTool(input: { url: string }): Promise<ToolResult> {
  let res: Response;
  try {
    res = await fetch(input.url, {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) KompassUI/1.0' },
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    });
  } catch (e) {
    return { ok: false, output: `fetch failed: ${String(e).slice(0, 200)}` };
  }
  if (!res.ok) return { ok: false, output: `HTTP ${res.status}` };
  const html = await res.text();
  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  ).trim();
  return { ok: true, output: clip(text, 20_000) };
}

// ---- slides tool ----

export interface SlideSpec {
  title: string;
  bullets?: string[];
  body?: string;
  notes?: string;
}

async function createPresentationTool(
  input: { filename: string; title: string; subtitle?: string; slides: SlideSpec[] },
  ctx: ToolContext,
): Promise<ToolResult> {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_16x9';
  const ACCENT = '2563EB';
  const DARK = '1E293B';

  const cover = pres.addSlide();
  cover.background = { color: DARK };
  cover.addText(input.title, {
    x: 0.6,
    y: 1.8,
    w: 12.1,
    h: 1.5,
    fontSize: 40,
    bold: true,
    color: 'FFFFFF',
  });
  if (input.subtitle)
    cover.addText(input.subtitle, {
      x: 0.6,
      y: 3.3,
      w: 12.1,
      h: 0.8,
      fontSize: 20,
      color: '94A3B8',
    });

  for (const s of input.slides) {
    const slide = pres.addSlide();
    slide.addText(s.title, {
      x: 0.6,
      y: 0.4,
      w: 12.1,
      h: 0.9,
      fontSize: 28,
      bold: true,
      color: DARK,
    });
    slide.addShape('rect', { x: 0.6, y: 1.25, w: 1.6, h: 0.06, fill: { color: ACCENT } });
    if (s.bullets?.length) {
      slide.addText(
        s.bullets.map((b) => ({ text: b, options: { bullet: { indent: 12 }, breakLine: true } })),
        { x: 0.7, y: 1.6, w: 11.9, h: 5.2, fontSize: 18, color: '334155', lineSpacing: 30 },
      );
    } else if (s.body) {
      slide.addText(s.body, { x: 0.7, y: 1.6, w: 11.9, h: 5.2, fontSize: 16, color: '334155' });
    }
    if (s.notes) slide.addNotes(s.notes);
  }

  const safe = input.filename.replace(/[^\w.-]+/g, '_').replace(/\.pptx$/i, '') + '.pptx';
  mkdirSync(ctx.outputDir, { recursive: true });
  const outPath = join(ctx.outputDir, safe);
  await pres.writeFile({ fileName: outPath });
  return {
    ok: true,
    output: `presentation written: ${outPath} (${1 + input.slides.length} slides)`,
    downloadUrl: `/output/${encodeURIComponent(safe)}`,
  };
}

// ---- registry ----

const path = { type: 'string', description: 'File path (relative to workspace or absolute)' };

export const TOOL_DEFS: Record<string, ToolDef> = {
  bash: {
    name: 'bash',
    description: 'Run a shell command in the workspace directory. Returns stdout+stderr.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Command to run' } },
      required: ['command'],
    },
  },
  read_file: {
    name: 'read_file',
    description: 'Read a text file, returning numbered lines. Use offset/limit for large files.',
    input_schema: {
      type: 'object',
      properties: { path, offset: { type: 'number' }, limit: { type: 'number' } },
      required: ['path'],
    },
  },
  write_file: {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content.',
    input_schema: {
      type: 'object',
      properties: { path, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  edit_file: {
    name: 'edit_file',
    description:
      'Replace an exact string in a file. old_string must match exactly once unless replace_all.',
    input_schema: {
      type: 'object',
      properties: {
        path,
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  list_files: {
    name: 'list_files',
    description: 'Recursively list files under a directory (skips node_modules, .git, etc).',
    input_schema: { type: 'object', properties: { path } },
  },
  search_files: {
    name: 'search_files',
    description: 'Regex-search file contents under a directory. Returns file:line: text matches.',
    input_schema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path },
      required: ['pattern'],
    },
  },
  web_search: {
    name: 'web_search',
    description: 'Search the web (DuckDuckGo). Returns titles, URLs and snippets.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  web_fetch: {
    name: 'web_fetch',
    description: 'Fetch a URL and return its readable text content (HTML stripped).',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  create_presentation: {
    name: 'create_presentation',
    description:
      'Generate a .pptx PowerPoint file from a slide outline. Call once with ALL slides. ' +
      'Each slide has a title plus bullets (preferred) or body text, and optional speaker notes.',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Output filename, e.g. q3-review.pptx' },
        title: { type: 'string', description: 'Deck title (cover slide)' },
        subtitle: { type: 'string' },
        slides: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              bullets: { type: 'array', items: { type: 'string' } },
              body: { type: 'string' },
              notes: { type: 'string' },
            },
            required: ['title'],
          },
        },
      },
      required: ['filename', 'title', 'slides'],
    },
  },
};

export const MODE_TOOLS: Record<string, string[]> = {
  chat: [],
  agentic: ['bash', 'read_file', 'write_file', 'edit_file', 'list_files', 'search_files'],
  research: ['web_search', 'web_fetch'],
  slides: ['web_search', 'web_fetch', 'create_presentation'],
};

/** Tools whose effects touch the machine — gated behind approval unless auto-approve. */
export const NEEDS_APPROVAL = new Set(['bash', 'write_file', 'edit_file']);

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'bash':
        return await runBash(String(input.command ?? ''), ctx);
      case 'read_file':
        return readFileTool(input as never, ctx);
      case 'write_file':
        return writeFileTool(input as never, ctx);
      case 'edit_file':
        return editFileTool(input as never, ctx);
      case 'list_files':
        return listFilesTool(input as never, ctx);
      case 'search_files':
        return searchFilesTool(input as never, ctx);
      case 'web_search':
        return await webSearchTool(input as never);
      case 'web_fetch':
        return await webFetchTool(input as never);
      case 'create_presentation':
        return await createPresentationTool(input as never, ctx);
      default:
        return { ok: false, output: `unknown tool: ${name}` };
    }
  } catch (e) {
    return { ok: false, output: `tool error: ${String(e).slice(0, 500)}` };
  }
}
