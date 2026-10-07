#!/usr/bin/env node
/**
 * Start an OpenMAIC generation run from a course-package JSON and, by default,
 * follow it to a terminal state.
 *
 *   node scripts/start-lesson-generation.mjs \
 *     --package course-packages/ctf/1-1-1.json \
 *     --base-url http://localhost:3000 \
 *     --anonymous-id 2f17ee10-95b7-448b-bd7f-282476f91430 \
 *     --folder "CTF综合实战"
 *
 * The package's `generation.requirement` is sent to POST /api/generation-runs
 * with `sceneTypes`/`interactive`/`taskEngine`/`outlineReview` from the same
 * block. Every lesson package is one slide-only course, so the run never
 * creates code or interactive scenes.
 *
 * `--anonymous-id` sets the `anonymous_id` cookie, so every run lands in the
 * same owner library. It accepts the cookie's UUID v4 value, with or without
 * the internal `anon:` prefix. `--folder` finds or creates a folder with that
 * name in the same owner library and files the generated stage into it once
 * the run completes. `--folder-id` uses an existing folder instead of a name.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const POLL_MS = 5_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function usage() {
  console.error(
    'Usage: node scripts/start-lesson-generation.mjs --package <path> ' +
      '[--base-url <url>] [--anonymous-id <uuid>] ' +
      '[--folder <name> | --folder-id <id>] [--no-wait] [--dry-run]',
  );
}

function parseArgs(argv) {
  const values = new Map();
  const valueFlags = new Set([
    '--package',
    '--base-url',
    '--anonymous-id',
    '--folder',
    '--folder-id',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-wait' || arg === '--dry-run' || arg === '--help' || arg === '-h') {
      values.set(arg, true);
      continue;
    }
    if (valueFlags.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value after ${arg}`);
      values.set(arg, value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return values;
}

function normalizeAnonymousId(value) {
  const raw = value.startsWith('anon:') ? value.slice('anon:'.length) : value;
  if (!UUID_V4.test(raw)) {
    throw new Error(
      '--anonymous-id must be an anonymous_id cookie value (UUID v4); ' +
        'the internal anon: prefix is optional',
    );
  }
  return raw;
}

function packageToRunInput(pkg) {
  const generation = pkg.generation ?? {};
  if (typeof generation.requirement !== 'string' || !generation.requirement.trim()) {
    throw new Error('The package is missing generation.requirement');
  }
  const sceneTypes = generation.sceneTypes ?? ['slide'];
  if (!Array.isArray(sceneTypes) || sceneTypes.length === 0 || !sceneTypes.includes('slide')) {
    throw new Error('generation.sceneTypes must contain slide');
  }
  if (sceneTypes.some((type) => type !== 'slide')) {
    throw new Error('Lesson packages are slide-only; generation.sceneTypes may only contain slide');
  }
  return {
    requirement: generation.requirement,
    materialIds: [],
    interactive: generation.interactive === true,
    taskEngine: generation.taskEngine === true,
    sceneTypes,
    agents: { mode: 'auto' },
    outlineReview: generation.outlineReview ?? 'auto',
  };
}

function cookieHeader(response) {
  const values =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
  return values.map((value) => value.split(';', 1)[0]).join('; ');
}

function errorMessage(payload, text) {
  if (payload && typeof payload === 'object') {
    const nested = payload.error;
    if (typeof nested === 'string') return nested;
    if (nested && typeof nested === 'object' && typeof nested.message === 'string') {
      return nested.message;
    }
    if (typeof payload.message === 'string') return payload.message;
    if (typeof payload.errorCode === 'string') return payload.errorCode;
  }
  return text.slice(0, 300);
}

async function readJson(response) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON, got HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${errorMessage(payload, text)}`);
  }
  return payload;
}

function parseBaseUrl(args) {
  return (args.get('--base-url') ?? 'http://localhost:3000').replace(/\/+$/, '');
}

async function apiRequest(baseUrl, path, { method = 'GET', cookie, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await readJson(response);
  return { response, payload };
}

async function listFolders(baseUrl, cookie) {
  const { payload } = await apiRequest(baseUrl, '/api/folders', { cookie });
  return Array.isArray(payload?.folders) ? payload.folders : [];
}

async function ensureFolderId(baseUrl, cookie, folderName, folderId) {
  if (folderId) return folderId;
  if (!folderName) return null;

  const folders = await listFolders(baseUrl, cookie);
  const existing = folders.find(
    (folder) => typeof folder?.name === 'string' && folder.name.toLowerCase() === folderName.toLowerCase(),
  );
  if (existing?.id) return existing.id;

  const { payload } = await apiRequest(baseUrl, '/api/folders', {
    method: 'POST',
    cookie,
    body: { name: folderName },
  });
  const created = payload?.folder?.id;
  if (!created) throw new Error('Folder creation response is missing folder.id');
  return created;
}

async function attachStageToFolder(baseUrl, cookie, stageId, folderId) {
  await apiRequest(baseUrl, '/api/folders/members', {
    method: 'POST',
    cookie,
    body: { stageId, folderId },
  });
}

const args = parseArgs(process.argv.slice(2));
if (args.get('--help') || args.get('-h')) {
  usage();
  process.exit(0);
}

const packagePath = args.get('--package');
if (!packagePath) {
  usage();
  process.exit(1);
}
if (args.get('--folder') && args.get('--folder-id')) {
  throw new Error('Use --folder or --folder-id, not both');
}

const packageFile = JSON.parse(readFileSync(resolve(packagePath), 'utf8'));
const input = packageToRunInput(packageFile);
const anonymousId = args.get('--anonymous-id')
  ? normalizeAnonymousId(args.get('--anonymous-id'))
  : undefined;
const folderName = args.get('--folder');
const folderId = args.get('--folder-id');
const baseUrl = parseBaseUrl(args);

if (args.get('--dry-run')) {
  console.log(
    JSON.stringify(
      {
        code: packageFile.code,
        title: packageFile.title,
        owner: anonymousId ? `anon:${anonymousId}` : 'mint-new-anonymous-owner',
        folder: folderId ?? folderName ?? null,
        input,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const suppliedCookie = anonymousId ? `anonymous_id=${anonymousId}` : '';
const startResponse = await fetch(`${baseUrl}/api/generation-runs`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(suppliedCookie ? { cookie: suppliedCookie } : {}),
  },
  body: JSON.stringify(input),
});
const startPayload = await readJson(startResponse);
const run = startPayload.run;
if (!run?.id) throw new Error('The server did not return a run id');
let cookie = cookieHeader(startResponse) || suppliedCookie;

console.log(`${packageFile.code} ${packageFile.title}`);
console.log(`run=${run.id} state=${run.state}`);
if (anonymousId) console.log(`owner=anon:${anonymousId}`);

if (args.get('--no-wait')) {
  if (folderName || folderId) {
    console.warn('--no-wait exits before stageId is known; folder attachment was skipped.');
  }
  process.exit(0);
}

for (;;) {
  const poll = await fetch(`${baseUrl}/api/generation-runs/${run.id}`, {
    headers: cookie ? { cookie } : {},
  });
  const payload = await readJson(poll);
  const snapshot = payload.run ?? {};
  const progress = snapshot.progress ?? { scenesCompleted: 0, scenesTotal: 0 };
  console.log(
    `${new Date().toISOString()} state=${snapshot.state} step=${snapshot.step ?? ''} ` +
      `scenes=${progress.scenesCompleted}/${progress.scenesTotal}` +
      `${snapshot.stageId ? ` stage=${snapshot.stageId}` : ''}` +
      `${snapshot.error?.message ? ` error=${snapshot.error.message}` : ''}`,
  );
  if (['completed', 'paused', 'ended'].includes(snapshot.state)) {
    if (snapshot.state === 'completed' && snapshot.stageId) {
      if (folderName || folderId) {
        try {
          const resolvedFolderId = await ensureFolderId(baseUrl, cookie, folderName, folderId);
          if (resolvedFolderId) {
            await attachStageToFolder(baseUrl, cookie, snapshot.stageId, resolvedFolderId);
            console.log(`folder=${resolvedFolderId} stage=${snapshot.stageId} attached`);
          }
        } catch (error) {
          console.warn(
            `Warning: the stage completed, but folder attachment failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    process.exit(snapshot.state === 'completed' ? 0 : 1);
  }
  await new Promise((resolveSleep) => setTimeout(resolveSleep, POLL_MS));
}
