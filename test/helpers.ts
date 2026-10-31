import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

/** Right-to-left override, bell and start-of-heading: what a hostile title might carry. */
export const HOSTILE_TITLE = 'Shop ‮exe.txt\u0007\u0001 home';

export function page(opts: { title?: string | null } = {}): string {
  const title = opts.title === undefined ? HOSTILE_TITLE : opts.title;
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width">',
    title === null ? '' : `<title>${title}</title>`,
    '<meta name="description" content="A test page">',
    '</head><body><h1>Hello</h1></body></html>',
  ].join('');
}

export interface Fixture {
  url: string;
  html: string;
  /** Milliseconds to hold every response, for the one-in-flight test. */
  delayMs: number;
  close(): Promise<void>;
}

/** A site on 127.0.0.1 that answers every path with `fixture.html`, so soft404 reports its title. */
export async function startFixture(): Promise<Fixture> {
  const state = { html: page(), delayMs: 0 };
  const server: Server = createHttpServer((req, res) => {
    setTimeout(() => {
      if (req.url === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nAllow: /\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(state.html);
    }, state.delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    get html() {
      return state.html;
    },
    set html(v: string) {
      state.html = v;
    },
    get delayMs() {
      return state.delayMs;
    },
    set delayMs(v: number) {
      state.delayMs = v;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A client wired to a fresh server in the same process. */
export async function connectClient(): Promise<{ client: Client; close(): Promise<void> }> {
  const server = createServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

// C0 controls, DEL, C1 controls, and bidi marks, embeddings, overrides and isolates.
export const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏؜‪-‮⁦-⁩]/;

/** Every string in a JSON-shaped value, keys included. */
export function allStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [k, ...allStrings(v)]);
  }
  return [];
}
