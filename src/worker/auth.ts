import type { Context, Next } from 'hono';
import type { Env } from './env';

/**
 * Bearer gate for every non-health route (BUILD_PLAN §6.10).
 * Claude Code sends the token as `Authorization: Bearer` (ANTHROPIC_AUTH_TOKEN)
 * or `x-api-key` (ANTHROPIC_API_KEY) — accept either header, same secret.
 */
export async function bearerAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const expected = c.env.KOMPASS_BEARER;
  const header = c.req.header('authorization');
  const apiKey = c.req.header('x-api-key');
  const presented = header?.startsWith('Bearer ') ? header.slice(7) : apiKey;
  if (!expected || !presented || !timingSafeEqual(presented, expected)) {
    return c.json(
      { type: 'error', error: { type: 'authentication_error', message: 'invalid bearer token' } },
      401,
    );
  }
  await next();
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
