'use client';

// AI Council UI: configure the seats, watch each agent research live, then read
// the judge's synthesis with the disagreements kept visible rather than smoothed
// away. Deliberately shows failed agents instead of hiding them — on free models
// a partial council is the normal case, and a user judging an answer deserves to
// know it came from two seats rather than four.
import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Gavel,
  Globe,
  Loader2,
  Scale,
  Search,
  Send,
  Square,
  Users,
  XCircle,
} from 'lucide-react';
import {
  runCouncil,
  type AgentSpec,
  type AgentState,
  type CouncilRun,
  type ResearchDepth,
} from '@/lib/council';
import { fetchModelRoster, type RosterEntry } from '@/lib/kompassClient';
import type { KompassSettings } from '@/lib/types';

/** Lane pseudo-models always available, even before the roster loads. */
const LANE_OPTIONS = [
  { value: 'kompass', label: 'Auto (classifier picks)' },
  { value: 'kompass-agentic', label: 'Agentic lane' },
  { value: 'kompass-hard', label: 'Hard lane' },
  { value: 'kompass-simple', label: 'Simple lane' },
  { value: 'kompass-fast', label: 'Fast lane' },
];

const SEAT_NAMES = ['Analyst A', 'Analyst B', 'Analyst C', 'Analyst D', 'Analyst E'];

function defaultAgents(count: number, roster: RosterEntry[]): AgentSpec[] {
  // Give each seat a DIFFERENT model where possible. A council of identical
  // models mostly agrees with itself, which defeats the entire point.
  return Array.from({ length: count }, (_, i) => ({
    id: `agent-${i}`,
    label: SEAT_NAMES[i] ?? `Analyst ${i + 1}`,
    model: roster[i]?.entry ?? 'kompass-agentic',
  }));
}

function PhaseBadge({ agent }: { agent: AgentState }) {
  const map: Record<AgentState['phase'], { text: string; cls: string; icon: React.ReactNode }> = {
    queued: { text: 'queued', cls: 'bg-white/10 text-white/50', icon: null },
    searching: {
      text: 'searching',
      cls: 'bg-sky-500/15 text-sky-300',
      icon: <Search className="h-3 w-3" />,
    },
    reading: {
      text: 'reading',
      cls: 'bg-violet-500/15 text-violet-300',
      icon: <Globe className="h-3 w-3" />,
    },
    thinking: {
      text: 'thinking',
      cls: 'bg-amber-500/15 text-amber-300',
      icon: <Loader2 className="h-3 w-3 animate-spin" />,
    },
    done: { text: 'done', cls: 'bg-emerald-500/15 text-emerald-300', icon: null },
    failed: {
      text: 'failed',
      cls: 'bg-red-500/15 text-red-300',
      icon: <XCircle className="h-3 w-3" />,
    },
  };
  const p = map[agent.phase];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${p.cls}`}
    >
      {p.icon}
      {p.text}
    </span>
  );
}

function AgentCard({ agent }: { agent: AgentState }) {
  const [open, setOpen] = useState(false);
  const busy = ['searching', 'reading', 'thinking'].includes(agent.phase);
  return (
    <div
      className={`flex flex-col rounded-xl border p-3 transition ${
        agent.phase === 'failed'
          ? 'border-red-500/30 bg-red-500/5'
          : busy
            ? 'border-brand-500/40 bg-white/[0.04]'
            : 'border-white/10 bg-white/[0.02]'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-white/90">{agent.spec.label}</div>
          <div className="truncate font-mono text-[11px] text-white/40">
            {agent.servedBy ?? agent.spec.model}
          </div>
        </div>
        <PhaseBadge agent={agent} />
      </div>

      {agent.detail && busy && (
        <div className="mt-2 truncate rounded-md bg-black/30 px-2 py-1 font-mono text-[11px] text-white/50">
          {agent.detail}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-white/40">
        <span>{agent.searches} searches</span>
        <span>{agent.reads} pages read</span>
        {agent.elapsedMs !== undefined && <span>{(agent.elapsedMs / 1000).toFixed(1)}s</span>}
        {agent.usage && <span>{agent.usage.input + agent.usage.output} tok</span>}
      </div>

      {agent.error && (
        <div className="mt-2 rounded-md bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
          {agent.error}
        </div>
      )}

      {agent.answer && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="mt-2 flex items-center gap-1 self-start text-[11px] text-white/50 transition hover:text-white/80"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {open ? 'hide' : 'show'} findings
        </button>
      )}

      {open && agent.answer && (
        <div className="mt-2 border-t border-white/10 pt-2">
          <div className="kompass-prose max-h-72 overflow-y-auto text-[13px] text-white/70">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{agent.answer}</ReactMarkdown>
          </div>
          {agent.sources.length > 0 && (
            <ul className="mt-2 space-y-1">
              {agent.sources.map((s) => (
                <li key={s.url}>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex items-center gap-1 truncate text-[11px] text-brand-400 hover:underline"
                  >
                    <ExternalLink className="h-3 w-3 shrink-0" />
                    <span className="truncate">{s.title}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function CouncilView({ settings }: { settings: KompassSettings }) {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [agentCount, setAgentCount] = useState(3);
  const [agents, setAgents] = useState<AgentSpec[]>(() => defaultAgents(3, []));
  const [judgeModel, setJudgeModel] = useState('kompass-hard');
  const [depth, setDepth] = useState<ResearchDepth>('fast');
  const [question, setQuestion] = useState('');
  const [run, setRun] = useState<CouncilRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [configOpen, setConfigOpen] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  // Real roster from the gateway, so the picker only offers models that exist
  // and are enabled right now.
  useEffect(() => {
    let cancelled = false;
    fetchModelRoster(settings)
      .then((r) => {
        if (cancelled) return;
        setRoster(r);
        setAgents((prev) =>
          prev.every((a) => a.model === 'kompass-agentic') ? defaultAgents(prev.length, r) : prev,
        );
      })
      .catch(() => {
        /* picker falls back to lane options — not worth surfacing */
      });
    return () => {
      cancelled = true;
    };
  }, [settings]);

  useEffect(() => {
    setAgents((prev) => {
      if (prev.length === agentCount) return prev;
      if (prev.length < agentCount) {
        const extra = defaultAgents(agentCount, roster).slice(prev.length);
        return [...prev, ...extra];
      }
      return prev.slice(0, agentCount);
    });
  }, [agentCount, roster]);

  const modelOptions = useMemo(
    () => [
      ...LANE_OPTIONS,
      ...roster.map((r) => ({
        value: r.entry,
        label: `${r.entry}${r.rate !== undefined ? `  (${r.rate}%)` : ''}`,
      })),
    ],
    [roster],
  );

  async function start() {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setConfigOpen(false);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await runCouncil({
        settings,
        question: q,
        agents,
        judgeModel,
        depth,
        onUpdate: setRun,
        signal: controller.signal,
      });
    } catch {
      /* cancellation — the run state already shows what happened */
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  const verdict = run?.verdict;
  const doneCount = run?.agents.filter((a) => a.phase === 'done').length ?? 0;
  const failedCount = run?.agents.filter((a) => a.phase === 'failed').length ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
      <header className="flex items-center gap-2">
        <Users className="h-5 w-5 text-brand-400" />
        <h1 className="text-lg font-semibold text-white/90">AI Council</h1>
        <span className="text-xs text-white/40">
          independent agents research in parallel, a judge weighs them
        </span>
      </header>

      {/* ── Configuration ─────────────────────────────────────────────── */}
      <div className="rounded-xl border border-white/10 bg-white/[0.02]">
        <button
          onClick={() => setConfigOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-white/70"
        >
          {configOpen ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          Council setup
          <span className="ml-auto text-xs text-white/40">
            {agentCount} agents · {depth} · judge: {judgeModel.split('/').pop()}
          </span>
        </button>

        {configOpen && (
          <div className="space-y-4 border-t border-white/10 p-4">
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-xs text-white/60">
                Agents
                <select
                  value={agentCount}
                  onChange={(e) => setAgentCount(Number(e.target.value))}
                  disabled={busy}
                  className="rounded-md border border-white/10 bg-black/40 px-2 py-1 text-white/80"
                >
                  {[2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex items-center gap-1 text-xs text-white/60">
                Mode
                <div className="ml-1 flex overflow-hidden rounded-md border border-white/10">
                  {(['fast', 'deep'] as ResearchDepth[]).map((d) => (
                    <button
                      key={d}
                      onClick={() => setDepth(d)}
                      disabled={busy}
                      className={`px-2.5 py-1 transition ${
                        depth === d
                          ? 'bg-brand-500 font-medium text-black/90'
                          : 'text-white/60 hover:bg-white/5'
                      }`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs text-white/60">
                <Gavel className="h-3.5 w-3.5" />
                Judge
                <select
                  value={judgeModel}
                  onChange={(e) => setJudgeModel(e.target.value)}
                  disabled={busy}
                  className="max-w-[16rem] rounded-md border border-white/10 bg-black/40 px-2 py-1 text-white/80"
                >
                  {modelOptions.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="space-y-2">
              {agents.map((a, i) => (
                <div key={a.id} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-xs text-white/50">{a.label}</span>
                  <select
                    value={a.model}
                    disabled={busy}
                    onChange={(e) =>
                      setAgents((prev) =>
                        prev.map((x, xi) => (xi === i ? { ...x, model: e.target.value } : x)),
                      )
                    }
                    className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/40 px-2 py-1 text-xs text-white/80"
                  >
                    {modelOptions.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <p className="text-[11px] leading-relaxed text-white/35">
              Different models per seat produce genuine disagreement — identical models mostly
              agree with themselves. Deep mode reads more pages per agent and takes noticeably
              longer on free models.
            </p>
          </div>
        )}
      </div>

      {/* ── Question ──────────────────────────────────────────────────── */}
      <div className="flex gap-2">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void start();
            }
          }}
          rows={2}
          placeholder="Ask the council a question worth more than one opinion…"
          className="min-w-0 flex-1 resize-none rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white/90 outline-none placeholder:text-white/30 focus:border-brand-500/50"
        />
        {busy ? (
          <button
            onClick={() => abortRef.current?.abort()}
            className="flex shrink-0 items-center gap-1.5 self-end rounded-xl border border-white/10 px-3 py-2 text-sm text-white/70 hover:bg-white/5"
          >
            <Square className="h-3.5 w-3.5" /> Stop
          </button>
        ) : (
          <button
            onClick={() => void start()}
            disabled={!question.trim()}
            className="flex shrink-0 items-center gap-1.5 self-end rounded-xl bg-brand-500 px-3 py-2 text-sm font-medium text-black/90 transition hover:bg-brand-400 disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" /> Convene
          </button>
        )}
      </div>

      {/* ── Agent cards ───────────────────────────────────────────────── */}
      {run && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {run.agents.map((a) => (
              <AgentCard key={a.spec.id} agent={a} />
            ))}
          </div>

          {/* ── Judge ───────────────────────────────────────────────── */}
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center gap-2">
              <Scale className="h-4 w-4 text-brand-400" />
              <span className="text-sm font-medium text-white/90">Council Judge</span>
              {run.judgePhase === 'deliberating' && (
                <span className="flex items-center gap-1 text-xs text-amber-300">
                  <Loader2 className="h-3 w-3 animate-spin" /> deliberating
                </span>
              )}
              {run.judgePhase === 'waiting' && (
                <span className="text-xs text-white/40">
                  waiting for agents ({doneCount} done{failedCount ? `, ${failedCount} failed` : ''}
                  )
                </span>
              )}
              {verdict?.servedBy && (
                <span className="ml-auto font-mono text-[11px] text-white/40">
                  {verdict.servedBy}
                </span>
              )}
            </div>

            {run.judgeError && (
              <div className="mt-3 flex items-start gap-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div>
                  {run.judgeError}
                  <div className="mt-1 text-red-300/70">
                    The individual findings above are unaffected — the research still stands.
                  </div>
                </div>
              </div>
            )}

            {verdict && (
              <div className="mt-3 space-y-4">
                {failedCount > 0 && (
                  <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                    Synthesized from {doneCount} of {run.agents.length} agents — {failedCount}{' '}
                    failed. Weigh accordingly.
                  </div>
                )}

                {verdict.degraded && (
                  <div className="rounded-md bg-white/5 px-3 py-2 text-xs text-white/50">
                    The judge did not return a parseable structure, so agreements and
                    disagreements could not be separated out. Its full reply is below.
                  </div>
                )}

                {verdict.disagreements.length > 0 && (
                  <div>
                    <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-300">
                      <AlertTriangle className="h-3.5 w-3.5" /> Disagreements
                    </h3>
                    <ul className="space-y-2">
                      {verdict.disagreements.map((d, i) => (
                        <li
                          key={i}
                          className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-2.5"
                        >
                          <div className="text-[13px] font-medium text-white/85">{d.point}</div>
                          <ul className="mt-1 space-y-0.5">
                            {d.positions.map((p, pi) => (
                              <li key={pi} className="text-[12px] text-white/60">
                                • {p}
                              </li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {verdict.agreements.length > 0 && (
                  <div>
                    <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-300">
                      Agreed
                    </h3>
                    <ul className="space-y-0.5">
                      {verdict.agreements.map((a, i) => (
                        <li key={i} className="text-[13px] text-white/70">
                          • {a}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div>
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-white/50">
                    Final answer
                  </h3>
                  <div className="kompass-prose text-[14px] text-white/85">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{verdict.answer}</ReactMarkdown>
                  </div>
                </div>

                {verdict.sources.length > 0 && (
                  <div>
                    <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-white/50">
                      Sources ({verdict.sources.length})
                    </h3>
                    <ol className="space-y-1">
                      {verdict.sources.map((s, i) => (
                        <li key={s.url} className="flex gap-2 text-[12px]">
                          <span className="shrink-0 text-white/30">[{i + 1}]</span>
                          <a
                            href={s.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="truncate text-brand-400 hover:underline"
                          >
                            {s.url}
                          </a>
                        </li>
                      ))}
                    </ol>
                    <p className="mt-2 text-[11px] text-white/30">
                      Every source listed was actually fetched by an agent during this run — none
                      are model-generated.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
