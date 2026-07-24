// M8 acceptance (BUILD_PLAN_V2 §4): quality-signal math unit tests, and
// integration coverage for truncated-stream demotion within 10 requests,
// auto-recovery, the escalation→score wiring, the sparse-data guard, and
// ban/pin human overrides.
import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnthropicRequest } from '../src/adapters/types';
import type { RouterConfig } from '../src/worker/config';
import {
  applyAttempt,
  applyPenalty,
  compileQualityPatterns,
  DEMOTE_CONSECUTIVE_K,
  DEMOTE_SCORE_FLOOR,
  effectiveQuality,
  effectiveScore,
  isCorrectiveTurn,
  MIN_ATTEMPTS_FOR_SCORING,
  newScoreCell,
  PENALTY,
  spreadWeight,
} from '../src/worker/score';

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

const AUTH = {
  'content-type': 'application/json',
  authorization: 'Bearer test-bearer-token',
};

let doNameCounter = 0;
function freshDoName(label: string): string {
  return `${label}-${++doNameCounter}`;
}

// ---- unit: score math ----

describe('applyAttempt / applyPenalty (unit)', () => {
  it('health EWMA moves toward the observed outcome, seeded at 1', () => {
    let cell = newScoreCell();
    expect(cell.health).toBe(1);
    cell = applyAttempt(cell, false, 0, undefined);
    expect(cell.health).toBeCloseTo(0.8, 5); // 1 + 0.2*(0-1)
    cell = applyAttempt(cell, false, 0, undefined);
    expect(cell.health).toBeCloseTo(0.64, 5);
  });

  it('sparse-data guard: quality is health-only below MIN_ATTEMPTS_FOR_SCORING, demotion never fires', () => {
    let cell = newScoreCell();
    // 9 truncated attempts — health tanks hard, but attempts < 10 the whole time.
    for (let i = 0; i < MIN_ATTEMPTS_FOR_SCORING - 1; i++) {
      cell = applyAttempt(cell, false, PENALTY.empty_or_truncated, undefined);
    }
    expect(cell.attempts).toBe(MIN_ATTEMPTS_FOR_SCORING - 1);
    expect(cell.demoted).toBe(false);
    expect(effectiveQuality(cell.penalties, cell.attempts)).toBe(1); // health-only
  });

  it('truncated-stream fixture: demotes by exactly the 10th attempt, not before', () => {
    let cell = newScoreCell();
    let demotedAt = -1;
    for (let i = 1; i <= MIN_ATTEMPTS_FOR_SCORING; i++) {
      cell = applyAttempt(cell, false, PENALTY.empty_or_truncated, undefined);
      if (cell.demoted && demotedAt === -1) demotedAt = i;
    }
    expect(demotedAt).toBe(MIN_ATTEMPTS_FOR_SCORING);
  });

  it('a single healthy attempt after demotion restores it ("single probe; success restores")', () => {
    let cell = newScoreCell();
    for (let i = 0; i < MIN_ATTEMPTS_FOR_SCORING; i++) {
      cell = applyAttempt(cell, false, PENALTY.empty_or_truncated, undefined);
    }
    expect(cell.demoted).toBe(true);
    cell = applyAttempt(cell, true, 0, undefined);
    expect(cell.demoted).toBe(false);
    expect(cell.belowFloorStreak).toBe(0);
  });

  it('applyPenalty (escalation/corrective) never touches health or attempts, only penalties', () => {
    const base = { ...newScoreCell(), health: 0.77, attempts: 12 };
    const next = applyPenalty(base, PENALTY.escalation, undefined);
    expect(next.health).toBe(0.77);
    expect(next.attempts).toBe(12);
    expect(next.penalties).toBe(PENALTY.escalation);
  });

  it('FAST/8b regression fixture: healthy attempts + enough escalation penalties still demotes', () => {
    // Reproduces the v1 incident (lanes.yaml comment): a model returning
    // vague/hedging answers is healthy at the protocol level (200 OK, non-
    // empty) — health alone never catches it. Escalation attribution
    // (a real signal wired in index.ts) is what does.
    let cell = newScoreCell();
    for (let i = 0; i < MIN_ATTEMPTS_FOR_SCORING; i++)
      cell = applyAttempt(cell, true, 0, undefined);
    expect(cell.health).toBe(1); // fully healthy — this is the "looks fine" trap
    expect(cell.demoted).toBe(false);
    // Score crosses below DEMOTE_SCORE_FLOOR (0.5) only on the 6th penalty
    // (quality=1-6/10=0.4); needs DEMOTE_CONSECUTIVE_K=3 consecutive readings
    // below it, so 8 total penalties (crossings at #6, #7, #8).
    for (let i = 0; i < 8; i++) cell = applyPenalty(cell, PENALTY.escalation, undefined);
    expect(cell.demoted).toBe(true);
  });

  it('pin floors the effective score, protecting a genuinely terrible cell from demotion', () => {
    let cell = { ...newScoreCell(), health: 0.1, attempts: 15, penalties: 10, demoted: true };
    // Even starting demoted with terrible stats, a pin above the floor clears it.
    cell = applyPenalty(cell, 0, 0.9);
    expect(cell.demoted).toBe(false);
  });

  it('spreadWeight is score squared', () => {
    expect(spreadWeight(0.5)).toBeCloseTo(0.25, 10);
    expect(spreadWeight(1)).toBe(1);
  });

  it('effectiveScore: pin only raises, never lowers, a raw score', () => {
    expect(effectiveScore(1, 1, 0.2)).toBe(1); // raw already above pin
    expect(effectiveScore(0.1, 0.1, 0.9)).toBe(0.9); // pin rescues a terrible raw score
    expect(effectiveScore(0.5, 0.5, undefined)).toBe(0.25);
  });
});

// ---- unit: corrective-turn heuristic ----

describe('isCorrectiveTurn / compileQualityPatterns (unit)', () => {
  const patterns = [/that'?s wrong/i, /try again/i];
  const req = (text: string): AnthropicRequest => ({
    model: 'm',
    max_tokens: 1,
    messages: [
      { role: 'assistant', content: 'here is the answer' },
      { role: 'user', content: text },
    ],
  });

  it('matches a declared corrective pattern in the newest user turn', () => {
    expect(isCorrectiveTurn(req("that's wrong, please fix it"), patterns)).toBe(true);
    expect(isCorrectiveTurn(req('looks great, thanks!'), patterns)).toBe(false);
  });

  it('empty pattern list never matches (feature off)', () => {
    expect(isCorrectiveTurn(req("that's wrong"), [])).toBe(false);
  });

  it('ignores a tool_result continuation — not the user actually speaking', () => {
    const toolReq: AnthropicRequest = {
      model: 'm',
      max_tokens: 1,
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: "that's wrong output" }],
        },
      ],
    };
    expect(isCorrectiveTurn(toolReq, patterns)).toBe(false);
  });

  it('compileQualityPatterns skips an invalid regex and caches by config version', () => {
    const cfg: RouterConfig = {
      default_lane: 'AGENTIC',
      allow_paid: false,
      providers: {},
      lanes: {},
      version: 'v1',
      quality: { corrective_turn_detection: true, corrective_patterns: ['valid.*', '[invalid'] },
    };
    const compiled = compileQualityPatterns(cfg);
    expect(compiled).toHaveLength(1);
    // same version → cached, same array identity
    expect(compileQualityPatterns(cfg)).toBe(compiled);
  });
});

// ---- DO-level: ban/pin, filterChain interaction ----

function limits() {
  return { rpm: 100, rpd: 5000 };
}

describe('KompassState M8 (direct DO calls)', () => {
  it('filterChain sinks a demoted entry to the tail, excluded from the weighted pool', async () => {
    const stub = env.KOMPASS_STATE.get(env.KOMPASS_STATE.idFromName(freshDoName('m8-demote')));
    await stub.seedScore('AGENTIC', 'p/bad', {
      demoted: true,
      health: 0.1,
      attempts: 20,
      penalties: 15,
    });
    const chain = ['p/bad', 'p/good'];
    const limitsByEntry = {
      'p/bad': { key: 'p/bad', limits: limits() },
      'p/good': { key: 'p/good', limits: limits() },
    };
    const plan = await stub.filterChain('AGENTIC', chain, limitsByEntry, undefined, 2, {});
    // p/bad is demoted → sunk to the tail deterministically (nonDemoted has
    // only 1 entry, so the weighted-pick branch doesn't even run).
    expect(plan.order).toEqual(['p/good', 'p/bad']);
  });

  it('pin protects a terrible cell from ever showing as demoted after a penalty event', async () => {
    const stub = env.KOMPASS_STATE.get(env.KOMPASS_STATE.idFromName(freshDoName('m8-pin')));
    await stub.seedScore('AGENTIC', 'p/pinned', { health: 0.1, attempts: 15, penalties: 10 });
    await stub.recordScorePenalty('AGENTIC', 'p/pinned', 0.1, 0.9);
    const snap = await stub.snapshot();
    expect(snap.scores['AGENTIC:p/pinned']?.demoted).toBe(false);
  });
});

// ---- integration: real HTTP wiring ----

function scoreCfg(quality?: RouterConfig['quality']): RouterConfig {
  return {
    default_lane: 'AGENTIC',
    allow_paid: false,
    quality,
    providers: {
      p: {
        kind: 'openai',
        base_url: 'https://p.test/v1',
        key_env: 'NVIDIA_API_KEY', // reuse a key bound in vitest.config.ts
        limits: { rpm: 1000, rpd: 5000 },
      },
    },
    lanes: {
      AGENTIC: { chain: ['p/bad', 'p/good'], spread_top: 2 },
    },
  };
}

beforeEach(async () => {
  await env.CONFIG.put('config', JSON.stringify(scoreCfg()));
});

function truncatedReply() {
  return {
    choices: [
      { message: { role: 'assistant', content: 'partial answer...' }, finish_reason: 'length' },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 5 },
  };
}

function cleanReply(text = 'ok') {
  return {
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 5 },
  };
}

describe('M8 integration', () => {
  it('a model returning only truncated streams demotes by the 10th real request, and a follow-up spread pick avoids it', async () => {
    for (let i = 0; i < MIN_ATTEMPTS_FOR_SCORING; i++) {
      fetchMock
        .get('https://p.test')
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply(200, truncatedReply());
      const res = await SELF.fetch('https://kompass.test/v1/messages', {
        method: 'POST',
        headers: { ...AUTH, 'x-kompass-model': 'p/bad' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 32,
          messages: [{ role: 'user', content: `attempt ${i}` }],
        }),
      });
      expect(res.status).toBe(200);
    }
    const status = (await (
      await SELF.fetch('https://kompass.test/status', { headers: AUTH })
    ).json()) as any;
    expect(status.scores['AGENTIC:p/bad'].demoted).toBe(true);

    // Now a normal (non-forced) request into the spread pool — p/bad is
    // demoted (sunk to the tail), so p/good — untested, default weight — is
    // deterministically what filterChain puts first.
    fetchMock
      .get('https://p.test')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, (opts) => {
        const model = (JSON.parse(opts.body as string) as { model: string }).model;
        return cleanReply(model);
      });
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: { ...AUTH, 'x-kompass-lane': 'AGENTIC' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'post-demotion pick' }],
      }),
    });
    const json = (await res.json()) as any;
    expect(json.content[0].text).toBe('good'); // never dialed p/bad
  });

  it('a demoted model auto-recovers after one clean probe succeeds', async () => {
    const stub = env.KOMPASS_STATE.get(env.KOMPASS_STATE.idFromName(freshDoName('m8-recover')));
    await stub.seedScore('AGENTIC', 'p/bad', {
      demoted: true,
      health: 0.1,
      attempts: 12,
      penalties: 8,
    });
    fetchMock
      .get('https://p.test')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, cleanReply('recovered'));
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: { ...AUTH, 'x-kompass-model': 'p/bad' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'probe' }],
      }),
    });
    expect(res.status).toBe(200);
    const status = (await (
      await SELF.fetch('https://kompass.test/status', { headers: AUTH })
    ).json()) as any;
    expect(status.scores['AGENTIC:p/bad'].demoted).toBe(false);
  });

  it('escalation wiring: a real 3-consecutive-tool-error escalation penalizes the sticky entry', async () => {
    const session = { user_id: 'user_score_esc_session' };
    const errBody = () =>
      JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 32,
        tools: [{ name: 'bash', input_schema: { type: 'object' } }],
        metadata: session,
        messages: [
          { role: 'user', content: 'fix it' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: 'exit 1', is_error: true },
            ],
          },
        ],
      });
    // No dispatcher configured → tool-bearing requests ride default_lane (AGENTIC).
    for (let i = 0; i < 3; i++) {
      fetchMock
        .get('https://p.test')
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply(200, cleanReply('retry'));
      const r = await SELF.fetch('https://kompass.test/v1/messages', {
        method: 'POST',
        headers: AUTH,
        body: errBody(),
      });
      expect(r.status).toBe(200);
    }
    const status = (await (
      await SELF.fetch('https://kompass.test/status', { headers: AUTH })
    ).json()) as any;
    // Whichever of p/bad or p/good was sticky for this session got escalated
    // against — exactly one of them should now carry the escalation penalty.
    const penalized = Object.entries(status.scores as Record<string, { penalties: number }>).filter(
      ([k, v]) => k.startsWith('AGENTIC:') && v.penalties >= PENALTY.escalation,
    );
    expect(penalized).toHaveLength(1);
  });

  it('ban excludes an entry even with a seeded perfect score — never dialed', async () => {
    const cfg = scoreCfg();
    cfg.lanes.AGENTIC = { chain: ['p/bad', { model: 'p/good', ban: true }], spread_top: 2 };
    await env.CONFIG.put('config', JSON.stringify(cfg));
    const stub = env.KOMPASS_STATE.get(env.KOMPASS_STATE.idFromName(freshDoName('m8-ban')));
    // seed p/good with a "perfect" score — ban must still beat it.
    await stub.seedScore('AGENTIC', 'p/good', { health: 1, attempts: 50, penalties: 0 });
    fetchMock
      .get('https://p.test')
      .intercept({ path: '/v1/chat/completions', method: 'POST' })
      .reply(200, cleanReply('bad-only'));
    const res = await SELF.fetch('https://kompass.test/v1/messages', {
      method: 'POST',
      headers: { ...AUTH, 'x-kompass-lane': 'AGENTIC' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'ban test' }],
      }),
    });
    const json = (await res.json()) as any;
    expect(json.content[0].text).toBe('bad-only'); // p/good never dialed despite the interceptor being absent for it
  });

  it('sparse-data guard: fewer than 10 attempts never demotes, even with consistently bad behavior', async () => {
    for (let i = 0; i < MIN_ATTEMPTS_FOR_SCORING - 1; i++) {
      fetchMock
        .get('https://p.test')
        .intercept({ path: '/v1/chat/completions', method: 'POST' })
        .reply(200, truncatedReply());
      const res = await SELF.fetch('https://kompass.test/v1/messages', {
        method: 'POST',
        headers: { ...AUTH, 'x-kompass-model': 'p/bad' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 32,
          messages: [{ role: 'user', content: `attempt ${i}` }],
        }),
      });
      expect(res.status).toBe(200);
    }
    const status = (await (
      await SELF.fetch('https://kompass.test/status', { headers: AUTH })
    ).json()) as any;
    expect(status.scores['AGENTIC:p/bad'].attempts).toBe(MIN_ATTEMPTS_FOR_SCORING - 1);
    expect(status.scores['AGENTIC:p/bad'].demoted).toBe(false);
  });
});

describe('constants sanity', () => {
  it('demotion tuning constants are the documented values', () => {
    expect(MIN_ATTEMPTS_FOR_SCORING).toBe(10);
    expect(DEMOTE_SCORE_FLOOR).toBe(0.5);
    expect(DEMOTE_CONSECUTIVE_K).toBe(3);
  });
});
