/**
 * Every curriculum route, with no database behind it, answers the same Chinese 404.
 *
 * The workspace gate is one line at the top of every handler — inline in the
 * routes, and inside `runDesignRoute` for the 27 design routes — and its body is
 * plain text, not JSON. That makes it the one message in this API that no client
 * parses and no other suite asserts: `persistence-routes-gate.test.ts` pins the
 * *status* of the neighbouring routes but not the body, so a route could serve
 * English, or a bare 500 from a store it never should have reached, and every
 * suite would stay green.
 *
 * So this drives the real handlers. `isServerPersistenceConfigured()` is exactly
 * `Boolean(process.env.DATABASE_URL)`, so removing the variable closes every
 * gate; the gate is the first statement, so a request with no body, no owner and
 * no real ids still exercises it and nothing after it.
 *
 * The routes are discovered by walking the directory, not listed — a new route
 * that forgets the gate is a failure here rather than an untested file. A
 * hand-written list would be silent about precisely the route someone just
 * added.
 */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const ROUTES_ROOT = 'app/api/curriculum';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

const GATE_BODY = '未找到';

function discoverRoutes(): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(resolve(repositoryRoot, directory), { withFileTypes: true })) {
      const child = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name === 'route.ts') files.push(child);
    }
  };
  walk(ROUTES_ROOT);
  return files.sort();
}

/** The path a client would call, with dynamic segments filled by a placeholder. */
function routePath(file: string): string {
  return file
    .replace(/^app/, '')
    .replace(/\/route\.ts$/, '')
    .replace(/\[[^\]]+\]/g, 'x');
}

const routes = discoverRoutes();

describe('the not-configured 404', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('discovers every curriculum route, so a new one cannot be missed', () => {
    expect(routes.length).toBeGreaterThanOrEqual(61);
  });

  it('is the same Chinese body from every handler of every route', async () => {
    const failures: string[] = [];
    let checked = 0;

    for (const file of routes) {
      const loaded = (await import(
        /* @vite-ignore */ pathToFileURL(resolve(repositoryRoot, file)).href
      )) as Record<string, unknown>;
      const handlers = HTTP_METHODS.filter((method) => typeof loaded[method] === 'function');
      expect(handlers.length, `${file} exports no HTTP handler`).toBeGreaterThan(0);

      for (const method of handlers) {
        checked += 1;
        const handler = loaded[method] as (
          request: NextRequest,
          context: { params: Promise<Record<string, string>> },
        ) => Promise<Response>;
        const response = await handler(
          new NextRequest(new URL(routePath(file), 'http://localhost'), { method }),
          { params: Promise.resolve({}) },
        );
        const body = await response.text();
        if (response.status !== 404 || body !== GATE_BODY) {
          failures.push(
            `${method} ${routePath(file)} -> ${response.status} ${JSON.stringify(body)}`,
          );
        }
      }
    }

    expect(checked).toBeGreaterThanOrEqual(61);
    expect(failures).toEqual([]);
  }, 60_000); // is a bound on the transform, not on the behaviour under test. // 61 route modules are transformed and imported one by one; the default 5s
});
