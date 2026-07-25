import { NextResponse } from 'next/server';
import { webSearchDetailed } from '@/lib/scrape';

export async function POST(req: Request) {
  let body: { query?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }
  if (!body.query || typeof body.query !== 'string') {
    return NextResponse.json({ error: 'query (string) is required' }, { status: 400 });
  }
  try {
    // `backend` and `tried` are returned so a failing chain is diagnosable from
    // outside — the previous single-backend route could only say "HTTP 403",
    // with no way to tell which engine refused or whether any alternative was
    // attempted.
    const { results, backend, tried } = await webSearchDetailed(body.query);
    if (results.length === 0) {
      return NextResponse.json(
        { error: `all search backends failed: ${tried.join('; ')}`, tried },
        { status: 502 },
      );
    }
    return NextResponse.json({ results, backend, tried });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 502 });
  }
}
