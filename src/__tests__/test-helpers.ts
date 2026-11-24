import { vi } from 'vitest';
import type { CallToolResult } from '../tools/types.js';

/** Extracts the text of the first content block, failing loudly if it isn't text. */
export function textOf(result: CallToolResult): string {
  const block = result.content?.[0];
  if (!block || block.type !== 'text') {
    throw new Error(`Expected a text content block, got: ${JSON.stringify(block)}`);
  }
  return block.text;
}

/** The JSON inside a <prtg-data> block (or the whole text when unwrapped). */
export function dataOf(result: CallToolResult): any {
  const text = textOf(result);
  const m = /^<prtg-data>\n([\s\S]*)\n<\/prtg-data>\n/.exec(text);
  return JSON.parse(m ? m[1] : text);
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** A table.json answer. */
export function table(content: string, rows: unknown[], treesize = rows.length): Response {
  return json({ 'prtg-version': '25.1.104.1961', treesize, [content]: rows });
}

export type Route = (url: URL) => Response | Promise<Response> | undefined;

/**
 * A fake fetch that answers by endpoint (status.json, getsensordetails.json, ...)
 * or, for table.json, by "table.json:<content>". Unrouted requests fail the test.
 */
export function fakePrtg(routes: Record<string, Route | Response>) {
  const calls: URL[] = [];
  const fn = vi.fn(async (u: string) => {
    const url = new URL(u);
    calls.push(url);
    const endpoint = url.pathname.replace(/^.*\/api\//, '');
    const key = endpoint === 'table.json' ? `table.json:${url.searchParams.get('content')}` : endpoint;
    const route = routes[key] ?? routes[endpoint];
    if (route === undefined) throw new Error(`Unrouted request: ${key}`);
    if (route instanceof Response) return route.clone();
    const r = await route(url);
    if (!r) throw new Error(`Route returned nothing: ${key}`);
    return r;
  });
  return { fn, calls };
}
