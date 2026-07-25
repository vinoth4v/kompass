import { NextResponse } from 'next/server';
import {
  getData,
  getNews,
  getReference,
  type DataKind,
  type ReferenceKind,
} from '@/lib/dataSources';

const KINDS = ['weather', 'sports', 'fx', 'crypto', 'stock', 'macro'] as const;
const REF_KINDS = [
  'pubmed',
  'drug',
  'trials',
  'quakes',
  'book',
  'country',
  'package',
  'cve',
  'food',
  'entity',
  'music',
] as const;

/**
 * One route multiplexing every structured source, rather than a route per
 * source: they share error handling, and the model-facing tool surface stays
 * small. Free models call tools worse the more of them there are.
 */
export async function POST(req: Request) {
  let body: { kind?: string; query?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }
  const query = typeof body.query === 'string' ? body.query : '';
  if (!query) return NextResponse.json({ error: 'query (string) is required' }, { status: 400 });

  try {
    if (body.kind === 'news') {
      const r = await getNews(query);
      return NextResponse.json(r);
    }
    if (REF_KINDS.includes(body.kind as (typeof REF_KINDS)[number])) {
      return NextResponse.json(await getReference(body.kind as ReferenceKind, query));
    }
    if (!KINDS.includes(body.kind as (typeof KINDS)[number])) {
      return NextResponse.json(
        { error: `kind must be one of: news, ${KINDS.join(', ')}, ${REF_KINDS.join(', ')}` },
        { status: 400 },
      );
    }
    const r = await getData(body.kind as DataKind, query);
    return NextResponse.json(r);
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 300) }, { status: 502 });
  }
}
