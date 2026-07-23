// Kompass UI — local web interface (chat / agentic / research / slides) with
// Kompass as the LLM backend. Started via `kompass ui` or `pnpm ui`.
//
// Architecture: this Node server executes tools locally (bash, file edits, web
// search, pptx generation) and runs the agent loop; every model call goes to
// the deployed Kompass Worker's /v1/messages (Anthropic Messages API + tools).
// The browser talks to this server only — the Kompass bearer never reaches the
// page. Binds 127.0.0.1 exclusively; risky tools (bash/write/edit) require
// per-action approval in the UI unless the user enables auto-approve.
import { createServer, type ServerResponse } from 'node:http';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execTimeoutSafe } from './open-browser';
import { executeTool, MODE_TOOLS, NEEDS_APPROVAL, TOOL_DEFS, type ToolContext } from './tools';

const PORT = Number(process.env.KOMPASS_UI_PORT ?? 4876);
const KOMPASS_URL = (process.env.KOMPASS_URL ?? 'https://kompass.vinoth4v.workers.dev').replace(
  /\/$/,
  '',
);
const DATA_DIR = join(homedir(), '.kompass', 'ui');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');
const OUTPUT_DIR = join(DATA_DIR, 'output');
const MAX_ITERATIONS = 40;

function bearer(): string {
  if (process.env.KOMPASS_BEARER) return process.env.KOMPASS_BEARER;
  try {
    return JSON.parse(readFileSync('secrets/.secrets.json', 'utf8')).KOMPASS_BEARER as string;
  } catch {
    console.error(
      'No KOMPASS_BEARER env and secrets/.secrets.json unreadable — run from the kompass repo or set KOMPASS_BEARER',
    );
    process.exit(2);
  }
}
const BEARER = bearer();

// ---- mode system prompts ----

const PROMPTS: Record<string, string> = {
  chat:
    'You are a helpful, direct assistant. Answer in well-structured markdown. ' +
    'Be concise for simple questions and thorough for complex ones.',
  agentic:
    "You are an agentic coding assistant working in the user's workspace directory. " +
    'Use the tools to explore, edit and verify — read files before editing them, run ' +
    'commands to test your changes, and keep going until the task is done. ' +
    'Prefer edit_file for small changes and write_file for new files. ' +
    'After making changes, verify them (build, test, or re-read). ' +
    'Report what you did in markdown when finished.',
  research:
    "You are a research assistant. For the user's question, run several web_search " +
    'queries from different angles, then web_fetch the most promising results to read ' +
    'them in depth. Cross-check claims across sources. Finish with a well-structured ' +
    'markdown report: key findings first, then details, then a Sources section listing ' +
    'every URL you actually used.',
  slides:
    'You create PowerPoint decks. First, briefly confirm you understand the topic; use ' +
    'web_search/web_fetch if current facts are needed. Then design a clear narrative ' +
    'arc and call create_presentation ONCE with the complete deck: a strong title, and ' +
    '5-12 content slides, each with a sharp title and 3-6 concise bullets (add speaker ' +
    'notes with extra detail). After the tool succeeds, tell the user what the deck ' +
    'covers — the UI shows them a download button automatically.',
};

// ---- session store ----

interface StoredMessage {
  role: 'user' | 'assistant';
  content: unknown;
}
interface Session {
  id: string;
  mode: string;
  title: string;
  workspace?: string;
  created: number;
  updated: number;
  messages: StoredMessage[];
}

function loadSession(id: string): Session | null {
  const p = join(SESSIONS_DIR, `${id}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as Session;
}

function saveSession(s: Session): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  s.updated = Date.now();
  writeFileSync(join(SESSIONS_DIR, `${s.id}.json`), JSON.stringify(s, null, 2));
}

// ---- approval plumbing ----

const pendingApprovals = new Map<string, (approved: boolean) => void>();

function awaitApproval(id: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(id);
      resolve(false);
    }, 300_000);
    pendingApprovals.set(id, (approved) => {
      clearTimeout(timer);
      pendingApprovals.delete(id);
      resolve(approved);
    });
  });
}

// ---- kompass call ----

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

async function callKompass(
  mode: string,
  messages: StoredMessage[],
  tools: string[],
): Promise<{ content: ContentBlock[]; stop_reason: string }> {
  const body: Record<string, unknown> = {
    model: 'claude-sonnet-4-5',
    max_tokens: 8192,
    system: PROMPTS[mode] ?? PROMPTS.chat,
    messages,
  };
  if (tools.length) body.tools = tools.map((t) => TOOL_DEFS[t]);
  const res = await fetch(`${KOMPASS_URL}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${BEARER}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Kompass HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { content?: ContentBlock[]; stop_reason?: string };
  return { content: json.content ?? [], stop_reason: json.stop_reason ?? 'end_turn' };
}

// ---- agent loop (streams SSE events to the browser) ----

function sse(res: ServerResponse, event: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function runAgent(
  res: ServerResponse,
  req: {
    sessionId?: string;
    mode?: string;
    message?: string;
    workspace?: string;
    autoApprove?: boolean;
  },
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const mode = req.mode && PROMPTS[req.mode] ? req.mode : 'chat';
  let session = req.sessionId ? loadSession(req.sessionId) : null;
  if (!session) {
    session = {
      id: crypto.randomUUID().slice(0, 12),
      mode,
      title: (req.message ?? 'New session').slice(0, 64),
      workspace: req.workspace,
      created: Date.now(),
      updated: Date.now(),
      messages: [],
    };
  }
  if (req.workspace) session.workspace = req.workspace;
  const ctx: ToolContext = {
    workspace:
      session.workspace && existsSync(session.workspace) ? session.workspace : process.cwd(),
    outputDir: OUTPUT_DIR,
  };
  const tools = MODE_TOOLS[mode] ?? [];

  session.messages.push({ role: 'user', content: req.message ?? '' });
  sse(res, { type: 'session', id: session.id, mode, workspace: ctx.workspace });

  try {
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const { content, stop_reason } = await callKompass(mode, session.messages, tools);
      session.messages.push({ role: 'assistant', content });
      saveSession(session);

      for (const block of content) {
        if (block.type === 'text' && block.text) sse(res, { type: 'text', text: block.text });
      }

      const toolUses = content.filter((b) => b.type === 'tool_use');
      if (stop_reason !== 'tool_use' || toolUses.length === 0) break;

      const results: ContentBlock[] = [];
      for (const tu of toolUses) {
        const name = tu.name ?? '';
        const input = tu.input ?? {};
        let approved = true;
        if (NEEDS_APPROVAL.has(name) && !req.autoApprove) {
          const approvalId = crypto.randomUUID().slice(0, 8);
          sse(res, { type: 'approval_request', id: approvalId, tool: name, input });
          approved = await awaitApproval(approvalId);
          sse(res, { type: 'approval_resolved', id: approvalId, approved });
        }
        if (!approved) {
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: 'The user denied this action. Adjust your approach or ask them why.',
            is_error: true,
          });
          continue;
        }
        sse(res, { type: 'tool_start', tool: name, input });
        const result = await executeTool(name, input, ctx);
        sse(res, {
          type: 'tool_result',
          tool: name,
          ok: result.ok,
          output: result.output.slice(0, 4000),
          downloadUrl: result.downloadUrl,
        });
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result.output,
          is_error: result.ok ? undefined : true,
        });
      }
      session.messages.push({ role: 'user', content: results });
      saveSession(session);
    }
  } catch (e) {
    sse(res, { type: 'error', message: String(e).slice(0, 500) });
  }
  saveSession(session);
  sse(res, { type: 'done', sessionId: session.id });
  res.end();
}

// ---- http plumbing ----

function readBody(req: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString()));
    req.on('end', () => resolve(data));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const UI_HTML_PATH = join(dirname(fileURLToPath(import.meta.url)), 'ui.html');

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
    const p = url.pathname;

    if (p === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(UI_HTML_PATH, 'utf8'));
    } else if (p === '/api/config' && req.method === 'GET') {
      json(res, 200, {
        kompassUrl: KOMPASS_URL,
        workspaceDefault: process.cwd(),
        outputDir: OUTPUT_DIR,
      });
    } else if (p === '/api/sessions' && req.method === 'GET') {
      mkdirSync(SESSIONS_DIR, { recursive: true });
      const list = readdirSync(SESSIONS_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf8')) as Session)
        .sort((a, b) => b.updated - a.updated)
        .slice(0, 50)
        .map((s) => ({ id: s.id, mode: s.mode, title: s.title, updated: s.updated }));
      json(res, 200, list);
    } else if (p.startsWith('/api/sessions/') && req.method === 'GET') {
      const s = loadSession(p.split('/')[3] ?? '');
      if (!s) json(res, 404, { error: 'not found' });
      else json(res, 200, s);
    } else if (p.startsWith('/api/sessions/') && req.method === 'DELETE') {
      const id = (p.split('/')[3] ?? '').replace(/[^\w-]/g, '');
      const file = join(SESSIONS_DIR, `${id}.json`);
      if (existsSync(file)) unlinkSync(file);
      json(res, 200, { ok: true });
    } else if (p === '/api/agent' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}') as Parameters<typeof runAgent>[1];
      await runAgent(res, body);
    } else if (p === '/api/approve' && req.method === 'POST') {
      const { id, approved } = JSON.parse((await readBody(req)) || '{}') as {
        id?: string;
        approved?: boolean;
      };
      const resolver = id ? pendingApprovals.get(id) : undefined;
      if (resolver) resolver(approved === true);
      json(res, 200, { ok: !!resolver });
    } else if (p === '/api/kompass-status' && req.method === 'GET') {
      const upstream = await fetch(`${KOMPASS_URL}/status`, {
        headers: { authorization: `Bearer ${BEARER}` },
      });
      json(res, upstream.status, await upstream.json().catch(() => ({})));
    } else if (p.startsWith('/output/') && req.method === 'GET') {
      const name = decodeURIComponent(p.slice('/output/'.length)).replace(/[/\\]/g, '');
      const file = join(OUTPUT_DIR, name);
      if (!existsSync(file)) return json(res, 404, { error: 'not found' });
      res.writeHead(200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'content-disposition': `attachment; filename="${name}"`,
      });
      res.end(readFileSync(file));
    } else {
      json(res, 404, { error: 'not found' });
    }
  })().catch((e) => {
    try {
      json(res, 500, { error: String(e).slice(0, 300) });
    } catch {
      /* headers already sent (mid-SSE) — nothing to do */
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = `http://127.0.0.1:${PORT}`;
  console.log(`Kompass UI → ${addr}  (backend: ${KOMPASS_URL})`);
  if (!process.argv.includes('--no-open')) execTimeoutSafe(`open ${addr}`);
});
