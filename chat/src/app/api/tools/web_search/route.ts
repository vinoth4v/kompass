import { NextResponse } from 'next/server';
import { webSearch } from '@/lib/scrape';

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
    const results = await webSearch(body.query);
    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 502 });
  }
}
