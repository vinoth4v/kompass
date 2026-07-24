import { NextResponse } from 'next/server';
import { webFetch } from '@/lib/scrape';

export async function POST(req: Request) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }
  if (!body.url || typeof body.url !== 'string') {
    return NextResponse.json({ error: 'url (string) is required' }, { status: 400 });
  }
  try {
    const text = await webFetch(body.url);
    return NextResponse.json({ text });
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 502 });
  }
}
