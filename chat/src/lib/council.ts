// AI Council: N agents research the same question independently and in
// parallel, then a judge reads every answer, names the disagreements, weighs
// the evidence and synthesizes one final answer.
//
// Two properties matter more than anything else here:
//
//   1. CITATIONS ARE GROUND TRUTH. Sources are collected from the URLs an agent
//      actually searched and fetched — never from what the model claims it
//      read. A council that confidently cites invented sources is worse than no
//      council, and models invent sources readily.
//
//   2. ONE AGENT FAILING MUST NOT KILL THE COUNCIL. These are free models: the
//      measured success rate across the roster runs 79-97%, so with 3+ agents a
//      failure somewhere is the common case, not the exception. Every agent is
//      settled independently and the judge works with whatever came back.
import {
  sendMessage,
  type AnthropicMessageWire,
  type AnthropicTextBlockWire,
  type AnthropicToolResultBlockWire,
  type AnthropicToolUseBlockWire,
  type AnthropicToolWire,
} from './kompassClient';
import type { KompassSettings } from './types';

export interface Source {
  title: string;
  url: string;
}

export type ResearchDepth = 'fast' | 'deep';

/** One seat on the council. `model` is either a kompass-<lane> name or a
 *  concrete "provider/model" entry, which is forced via x-kompass-model. */
export interface AgentSpec {
  id: string;
  label: string;
  model: string;
}

export type AgentPhase = 'queued' | 'searching' | 'reading' | 'thinking' | 'done' | 'failed';

export interface AgentState {
  spec: AgentSpec;
  phase: AgentPhase;
  /** Human-readable current activity — the query being searched, the page being read. */
  detail?: string;
  searches: number;
  reads: number;
  answer?: string;
  sources: Source[];
  error?: string;
  servedBy?: string | null;
  usage?: { input: number; output: number };
  elapsedMs?: number;
  /** The seat's preferred model was unavailable and it ran on lane routing. */
  fellBack?: boolean;
}

export interface Disagreement {
  point: string;
  positions: string[];
}

export interface CouncilVerdict {
  answer: string;
  agreements: string[];
  disagreements: Disagreement[];
  sources: Source[];
  servedBy?: string | null;
  /** Set when the judge's structured block could not be parsed and its prose
   *  was used as-is — the UI says so rather than pretending it found nothing. */
  degraded?: boolean;
}

export interface CouncilRun {
  agents: AgentState[];
  verdict?: CouncilVerdict;
  judgePhase: 'waiting' | 'deliberating' | 'done' | 'failed';
  judgeError?: string;
}

const TOOLS: AnthropicToolWire[] = [
  {
    name: 'web_search',
    description: 'Search the web. Returns a list of results with title, url and snippet.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query' } },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a URL and return its main page text (scripts/styles stripped).',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute URL to fetch' } },
      required: ['url'],
    },
  },
];

const DEPTH: Record<ResearchDepth, { iterations: number; guidance: string }> = {
  fast: {
    iterations: 3,
    guidance:
      'Work quickly: one or two searches, then read at most two of the most promising pages ' +
      'before answering.',
  },
  deep: {
    iterations: 7,
    guidance:
      'Be thorough: search from more than one angle, read three to five pages in full, and ' +
      'actively look for evidence that CONTRADICTS your initial view before answering.',
  },
};

function agentSystemPrompt(depth: ResearchDepth): string {
  return (
    'You are one member of a council of independent analysts. You are answering on your own — ' +
    'you cannot see the other members and must not assume they agree with you. ' +
    `${DEPTH[depth].guidance} ` +
    'Ground every substantive claim in a page you actually fetched. Where the sources conflict, ' +
    'say so explicitly and state which you find more credible and why. If the evidence is thin, ' +
    'say that plainly — a hedged answer is far more useful to the council than a confident ' +
    'invented one. Never cite a URL you did not fetch. ' +
    'Finish with a clear, self-contained answer in markdown.'
  );
}

const JUDGE_SYSTEM_PROMPT =
  'You are the Council Judge. Several independent analysts have researched the same question ' +
  'and each returned an answer plus the list of sources they actually read. Your job is NOT to ' +
  'redo the research and NOT to average the answers. It is to weigh them.\n\n' +
  'Do all of the following:\n' +
  '1. Identify what the analysts agree on.\n' +
  '2. Identify every material DISAGREEMENT, and for each say which position the evidence ' +
  'better supports and why. Do not paper over conflicts — a real disagreement that you surface ' +
  'is more valuable than a smooth answer that hides it.\n' +
  '3. Prefer claims backed by sources that were actually fetched. Treat an unsourced confident ' +
  'claim as weaker than a sourced hedged one.\n' +
  '4. Note anything important that NO analyst covered, if you can tell.\n\n' +
  'Reply with a fenced ```json block containing exactly:\n' +
  '{"agreements": ["..."], "disagreements": [{"point": "...", "positions": ["..."]}]}\n' +
  'Then, after the block, write the final synthesized answer in markdown. Cite sources inline ' +
  'as [n] matching the numbered source list you were given. The final answer must stand on its ' +
  'own for someone who never sees the individual analyses.';

interface SearchResultJson {
  results?: { title: string; url: string; snippet: string }[];
  error?: string;
}
interface FetchResultJson {
  text?: string;
  error?: string;
}

/** Model id for the wire, plus the header that forces a concrete model. */
function modelRequest(model: string): { model: string; extraHeaders?: Record<string, string> } {
  if (model.startsWith('kompass')) return { model };
  // A concrete provider/model entry: the gateway honours x-kompass-model and
  // skips lane selection entirely.
  return { model: 'kompass', extraHeaders: { 'x-kompass-model': model } };
}

async function runTool(
  call: AnthropicToolUseBlockWire,
  state: AgentState,
  seenUrls: Set<string>,
  emit: () => void,
  signal?: AbortSignal,
): Promise<AnthropicToolResultBlockWire> {
  if (call.name === 'web_search') {
    const query = String(call.input.query ?? '');
    state.phase = 'searching';
    state.detail = query;
    state.searches++;
    emit();
    try {
      const res = await fetch('/api/tools/web_search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
        signal,
      });
      const json = (await res.json()) as SearchResultJson;
      if (!res.ok || !json.results) {
        return {
          type: 'tool_result',
          tool_use_id: call.id,
          content: `search failed: ${json.error ?? res.status}`,
          is_error: true,
        };
      }
      const summary = json.results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join('\n\n');
      return { type: 'tool_result', tool_use_id: call.id, content: summary || 'no results' };
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: `search failed: ${String(e)}`,
        is_error: true,
      };
    }
  }

  if (call.name === 'web_fetch') {
    const url = String(call.input.url ?? '');
    state.phase = 'reading';
    state.detail = url;
    emit();
    try {
      const res = await fetch('/api/tools/web_fetch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
        signal,
      });
      const json = (await res.json()) as FetchResultJson;
      if (!res.ok) {
        return {
          type: 'tool_result',
          tool_use_id: call.id,
          content: `fetch failed: ${json.error ?? res.status}`,
          is_error: true,
        };
      }
      // Cited ONLY on a successful fetch: this is the moment the agent actually
      // read the page, which is what makes the citation trustworthy.
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        state.sources.push({ title: url.replace(/^https?:\/\//, '').slice(0, 80), url });
        state.reads++;
        emit();
      }
      return { type: 'tool_result', tool_use_id: call.id, content: json.text ?? '' };
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      return {
        type: 'tool_result',
        tool_use_id: call.id,
        content: `fetch failed: ${String(e)}`,
        is_error: true,
      };
    }
  }

  return {
    type: 'tool_result',
    tool_use_id: call.id,
    content: `unknown tool "${call.name}"`,
    is_error: true,
  };
}

async function runAgent(
  settings: KompassSettings,
  state: AgentState,
  question: string,
  depth: ResearchDepth,
  emit: () => void,
  signal?: AbortSignal,
  /** Overrides the seat's model — used for the lane-routing retry. */
  modelOverride?: string,
): Promise<void> {
  const started = Date.now();
  const { model, extraHeaders } = modelRequest(modelOverride ?? state.spec.model);
  // Agents were answering from search snippets alone: 3 searches, 0 pages read,
  // zero sources. An answer with no fetched source is precisely what this
  // council must not produce, so it gets pushed back once before being allowed
  // to conclude.
  let nudgedForSources = false;
  const history: AnthropicMessageWire[] = [{ role: 'user', content: question }];
  const seenUrls = new Set<string>();
  let totalIn = 0;
  let totalOut = 0;

  state.phase = 'thinking';
  emit();

  for (let iter = 0; iter < DEPTH[depth].iterations; iter++) {
    const { response, servedBy, exhausted } = await sendMessage(
      settings,
      {
        model,
        max_tokens: 4096,
        system: agentSystemPrompt(depth),
        messages: history,
        tools: TOOLS,
      },
      signal,
      extraHeaders,
    );
    // No model served this turn. The gateway says so with a 200 and a notice,
    // which is right for Claude Code and wrong for a council: rendering that
    // notice as an agent's "finding" is worse than showing no agent at all.
    if (exhausted) {
      throw new Error(
        'No free model could serve this agent (gateway lanes exhausted). ' +
          'Fewer agents, fast mode, or a different model per seat usually clears it.',
      );
    }
    state.servedBy = servedBy;
    totalIn += response.usage.input_tokens;
    totalOut += response.usage.output_tokens;
    state.usage = { input: totalIn, output: totalOut };

    const toolUses = response.content.filter(
      (b): b is AnthropicToolUseBlockWire => b.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      const draft =
        response.content
          .filter((b): b is AnthropicTextBlockWire => b.type === 'text')
          .map((b) => b.text)
          .join('\n\n') || '(no answer)';

      if (state.sources.length === 0 && !nudgedForSources && iter < DEPTH[depth].iterations - 1) {
        nudgedForSources = true;
        history.push({ role: 'assistant', content: response.content });
        history.push({
          role: 'user',
          content:
            'You have not fetched a single source yet — search snippets alone are not enough to ' +
            'answer on. Pick the most promising result and call web_fetch on it, then answer ' +
            'grounded in what you actually read.',
        });
        state.phase = 'thinking';
        emit();
        continue;
      }

      state.answer = draft;
      state.phase = 'done';
      state.detail = undefined;
      state.elapsedMs = Date.now() - started;
      emit();
      return;
    }

    history.push({ role: 'assistant', content: response.content });
    const results: AnthropicToolResultBlockWire[] = [];
    for (const call of toolUses) {
      results.push(await runTool(call, state, seenUrls, emit, signal));
    }
    history.push({ role: 'user', content: results });
    state.phase = 'thinking';
    state.detail = undefined;
    emit();
  }

  // Out of iterations: keep whatever was gathered rather than discarding the
  // agent entirely — partial evidence still informs the judge.
  state.answer =
    'Reached the research step limit before concluding. Partial findings only — treat with caution.';
  state.phase = 'done';
  state.elapsedMs = Date.now() - started;
  emit();
}

/** Pull the judge's ```json block out, tolerating the usual model sloppiness. */
function parseJudge(text: string): {
  agreements: string[];
  disagreements: Disagreement[];
  answer: string;
  degraded: boolean;
} {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      const parsed = JSON.parse(fence[1]!.trim()) as {
        agreements?: unknown;
        disagreements?: unknown;
      };
      const agreements = Array.isArray(parsed.agreements)
        ? parsed.agreements.filter((a): a is string => typeof a === 'string')
        : [];
      const disagreements = Array.isArray(parsed.disagreements)
        ? parsed.disagreements
            .filter((d): d is { point: unknown; positions: unknown } => !!d && typeof d === 'object')
            .map((d) => ({
              point: typeof d.point === 'string' ? d.point : '',
              positions: Array.isArray(d.positions)
                ? d.positions.filter((p): p is string => typeof p === 'string')
                : [],
            }))
            .filter((d) => d.point)
        : [];
      const answer = text.slice(fence.index! + fence[0].length).trim();
      return { agreements, disagreements, answer: answer || text, degraded: false };
    } catch {
      // fall through — a malformed block is not worth failing the whole run over
    }
  }
  return { agreements: [], disagreements: [], answer: text, degraded: true };
}

async function runJudge(
  settings: KompassSettings,
  judgeModel: string,
  question: string,
  agents: AgentState[],
  signal?: AbortSignal,
): Promise<CouncilVerdict> {
  // One numbered source list across the whole council, so the judge's inline
  // [n] citations resolve against something the UI can render.
  const sources: Source[] = [];
  const indexOf = new Map<string, number>();
  for (const a of agents) {
    for (const s of a.sources) {
      if (!indexOf.has(s.url)) {
        indexOf.set(s.url, sources.length + 1);
        sources.push(s);
      }
    }
  }

  const brief = agents
    .map((a) => {
      const cites = a.sources.map((s) => `[${indexOf.get(s.url)}] ${s.url}`).join('\n') || '(none)';
      return `### ${a.spec.label} (model: ${a.servedBy ?? a.spec.model})\n\nSources actually read:\n${cites}\n\nAnswer:\n${a.answer ?? '(no answer)'}`;
    })
    .join('\n\n---\n\n');

  const sourceList = sources.map((s, i) => `[${i + 1}] ${s.url}`).join('\n') || '(none)';
  const { model, extraHeaders } = modelRequest(judgeModel);
  const { response, servedBy, exhausted } = await sendMessage(
    settings,
    {
      model,
      max_tokens: 4096,
      system: JUDGE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Question:\n${question}\n\nNumbered sources available to cite:\n${sourceList}\n\nAnalyst reports:\n\n${brief}`,
        },
      ],
    },
    signal,
    extraHeaders,
  );

  if (exhausted) {
    throw new Error(
      'No free model could serve the judge (gateway lanes exhausted). ' +
        'The individual agent findings below are unaffected.',
    );
  }
  const text = response.content
    .filter((b): b is AnthropicTextBlockWire => b.type === 'text')
    .map((b) => b.text)
    .join('\n\n');
  const parsed = parseJudge(text);
  return {
    answer: parsed.answer,
    agreements: parsed.agreements,
    disagreements: parsed.disagreements,
    sources,
    servedBy,
    degraded: parsed.degraded,
  };
}

export interface CouncilOptions {
  settings: KompassSettings;
  question: string;
  agents: AgentSpec[];
  judgeModel: string;
  depth: ResearchDepth;
  onUpdate: (run: CouncilRun) => void;
  signal?: AbortSignal;
}

export async function runCouncil({
  settings,
  question,
  agents,
  judgeModel,
  depth,
  onUpdate,
  signal,
}: CouncilOptions): Promise<CouncilRun> {
  const run: CouncilRun = {
    agents: agents.map((spec) => ({ spec, phase: 'queued', searches: 0, reads: 0, sources: [] })),
    judgePhase: 'waiting',
  };
  const emit = () => onUpdate({ ...run, agents: run.agents.map((a) => ({ ...a })) });
  emit();

  // Staggered start. The seats still run concurrently, but launching five
  // research loops in the same instant collides with free-tier RPM ceilings
  // (OpenRouter is 20/min across ALL :free models) and the whole council can
  // come back exhausted. A short offset costs nothing perceptible and lets the
  // gateway's ledger pace them.
  const STAGGER_MS = 700;

  // allSettled, not all: a rejected agent must not take down the council.
  await Promise.allSettled(
    run.agents.map(async (state, i) => {
      try {
        if (i > 0) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, i * STAGGER_MS);
            signal?.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new DOMException('aborted', 'AbortError'));
            });
          });
        }
        await runAgent(settings, state, question, depth, emit, signal);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          state.phase = 'failed';
          state.error = 'cancelled';
          emit();
          throw e;
        }
        // Pinning a model via x-kompass-model gives the gateway a chain of
        // exactly ONE entry, so a transient cooldown on that model kills the
        // seat outright — the router's whole fallback ladder is bypassed. Retry
        // once on lane routing: a seat that answers on a different model is far
        // better than an empty chair, and the card says it fell back.
        const pinned = !state.spec.model.startsWith('kompass');
        if (pinned && !state.fellBack) {
          state.fellBack = true;
          state.error = undefined;
          state.sources = [];
          state.searches = 0;
          state.reads = 0;
          emit();
          try {
            await runAgent(settings, state, question, depth, emit, signal, 'kompass-agentic');
            return;
          } catch (e2) {
            if (e2 instanceof DOMException && e2.name === 'AbortError') throw e2;
            state.error = e2 instanceof Error ? e2.message : String(e2);
          }
        } else {
          state.error = e instanceof Error ? e.message : String(e);
        }
        state.phase = 'failed';
        state.detail = undefined;
        emit();
      }
    }),
  );

  if (signal?.aborted) return run;

  const usable = run.agents.filter((a) => a.phase === 'done' && a.answer);
  if (usable.length === 0) {
    run.judgePhase = 'failed';
    run.judgeError = 'Every agent failed — nothing to synthesize.';
    emit();
    return run;
  }

  run.judgePhase = 'deliberating';
  emit();
  try {
    run.verdict = await runJudge(settings, judgeModel, question, usable, signal);
    run.judgePhase = 'done';
  } catch (first) {
    if (first instanceof DOMException && first.name === 'AbortError') throw first;
    // Same pinning trap the seats hit: a judge pinned to one model has a chain
    // of one, so a cooldown on it ends the whole council with the research
    // already done. Retry once on lane routing before giving up.
    try {
      if (judgeModel.startsWith('kompass')) throw first;
      run.verdict = await runJudge(settings, 'kompass-agentic', question, usable, signal);
      run.judgePhase = 'done';
      run.judgeError = undefined;
      emit();
      return run;
    } catch {
      /* fall through to the original failure below */
    }
  }
  if (run.judgePhase !== 'done') {
    try {
      throw new Error(run.judgeError ?? 'judge failed');
    } catch (e) {
      run.judgePhase = 'failed';
      run.judgeError = e instanceof Error ? e.message : String(e);
      // A dead judge must not throw away the research: the UI still shows every
      // agent's answer and sources, which is most of the value.
    }
  }
  emit();
  return run;
}
