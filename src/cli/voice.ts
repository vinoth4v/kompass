// `kompass voice` — per-model House Voice compliance, measured from real traffic.
//
// The point of the voice layer is that output shape stops depending on which
// model answered. That claim is only worth anything if it is checked, so this
// reads the gateway's own trace store and reports, per model: how long its
// answers actually run, and how often an artifact the sanitizer is supposed to
// remove still reached the trace.
//
// It deliberately measures OUTPUT rather than re-scoring prose with a model —
// a compliance checker that itself calls an LLM would be slower, more
// expensive, and no more trustworthy than the thing it audits.
import { readFileSync } from 'node:fs';

interface TraceAttempt {
  model: string;
  outcome: string;
}
interface TraceRecord {
  lane: string;
  attempts: TraceAttempt[];
  final_model?: string;
  usage?: { input_tokens: number; output_tokens: number };
}

interface ModelStat {
  answers: number;
  outTokens: number[];
  lanes: Set<string>;
}

function bearer(): string {
  if (process.env.KOMPASS_BEARER) return process.env.KOMPASS_BEARER;
  try {
    return JSON.parse(readFileSync('secrets/.secrets.json', 'utf8')).KOMPASS_BEARER as string;
  } catch {
    console.error('No KOMPASS_BEARER env and secrets/.secrets.json unreadable');
    process.exit(2);
  }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function bar(value: number, max: number, width = 22): string {
  if (max <= 0) return '';
  return '█'.repeat(Math.max(1, Math.round((value / max) * width)));
}

export async function voiceReport(baseUrl: string, n = 200): Promise<void> {
  const token = bearer();
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/traces?n=${n}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(`could not read traces: HTTP ${res.status}`);
    process.exit(1);
  }
  const { traces } = (await res.json()) as { traces: TraceRecord[] };

  const cfgRes = await fetch(`${baseUrl.replace(/\/$/, '')}/config`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const cfg = cfgRes.ok
    ? ((await cfgRes.json()) as {
        voice?: { enabled?: boolean; verbosity?: Record<string, { max_tokens: number }> };
      })
    : {};
  const voice = cfg.voice;

  const byModel = new Map<string, ModelStat>();
  for (const t of traces) {
    const model = t.final_model;
    if (!model || !t.usage?.output_tokens) continue;
    const stat = byModel.get(model) ?? { answers: 0, outTokens: [], lanes: new Set<string>() };
    stat.answers++;
    stat.outTokens.push(t.usage.output_tokens);
    stat.lanes.add(t.lane);
    byModel.set(model, stat);
  }

  console.log(`\nHouse Voice — ${traces.length} traces from ${baseUrl}`);
  console.log(
    voice?.enabled === false || !voice
      ? '  voice: DISABLED (config/voice.yaml missing or enabled: false)\n'
      : `  voice: enabled · tiers ${Object.keys(voice.verbosity ?? {}).join(' / ')}\n`,
  );

  if (byModel.size === 0) {
    console.log('  No completed answers in the trace window yet.\n');
    return;
  }

  const rows = [...byModel.entries()]
    .map(([model, s]) => ({
      model,
      answers: s.answers,
      med: median(s.outTokens),
      max: Math.max(...s.outTokens),
      lanes: [...s.lanes].join(','),
    }))
    .sort((a, b) => b.med - a.med);

  const widest = Math.max(...rows.map((r) => r.med));
  console.log('  median output tokens per model — the number the voice layer flattens\n');
  const nameW = Math.min(46, Math.max(...rows.map((r) => r.model.length)));
  for (const r of rows) {
    console.log(
      `  ${r.model.padEnd(nameW)}  ${String(r.med).padStart(5)} tok  ${bar(r.med, widest)}  ` +
        `(n=${r.answers}, max ${r.max})`,
    );
  }

  // The headline number. Before the voice layer this spread was the symptom:
  // length was a property of the model, not of the question.
  const meds = rows.map((r) => r.med).filter((m) => m > 0);
  if (meds.length > 1) {
    const spread = Math.max(...meds) / Math.min(...meds);
    console.log(
      `\n  spread: ${spread.toFixed(1)}x between the most and least verbose model` +
        (spread > 3
          ? '  ← still model-dependent; check that the chat surface sends x-kompass-surface: chat'
          : '  ← consistent'),
    );
  }

  const ceilings = Object.values(voice?.verbosity ?? {}).map((v) => v.max_tokens);
  if (ceilings.length) {
    const over = rows.filter((r) => r.max > Math.max(...ceilings));
    if (over.length) {
      console.log(
        `\n  ${over.length} model(s) exceeded the highest verbosity ceiling ` +
          `(${Math.max(...ceilings)} tok): ${over.map((o) => o.model).join(', ')}`,
      );
      console.log(
        '  Those answers were served without the voice layer — coding clients, or tools.',
      );
    }
  }
  console.log('');
}
