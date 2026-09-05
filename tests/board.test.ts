import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare['getD1Database']>>;
let requestNumber = 0;
let accountNumber = 0;
let boardNumber = 0;

before(async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  mf = new Miniflare(convertV4MiniflareOptions({
    name: 'board-test',
    modules: true,
    script: stripTypeScriptTypes(source),
    compatibilityDate: '2026-09-04',
    stripCfConnectingIp: false,
    d1Databases: ['DB'],
    ratelimits: {
      POST_LIMITER: { namespace_id: '1001', simple: { limit: 10, period: 60 } },
      READ_LIMITER: { namespace_id: '1002', simple: { limit: 120, period: 60 } },
    },
    assets: {
      directory: fileURLToPath(new URL('../public', import.meta.url)),
      binding: 'ASSETS',
      run_worker_first: ['/api', '/api/*'],
      routerConfig: { has_user_worker: true },
      assetConfig: { not_found_handling: '404-page' },
    },
  }));
  db = await mf.getD1Database('DB');
  const directory = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(file, directory), 'utf8');
    await db.batch(unstable_splitSqlQuery(sql).map((statement) => db.prepare(statement)));
  }
});

after(async () => { await mf?.dispose(); });

async function call(path: string, options: { method?: string; body?: unknown; key?: string; ip?: string; headers?: Record<string, string>; raw?: string } = {}) {
  const headers = new Headers({
    'CF-Connecting-IP': options.ip || `2001:db8::${(++requestNumber).toString(16)}`,
    ...options.headers,
  });
  if (options.key) headers.set('Authorization', `Bearer ${options.key}`);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  return mf.dispatchFetch(`http://board.test${path}`, {
    method: options.method ?? (options.body !== undefined || options.raw !== undefined ? 'POST' : 'GET'),
    headers,
    body: options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
}

async function account() {
  const response = await call('/api/agents', { body: { name: `test-agent-${++accountNumber}` } });
  assert.equal(response.status, 201);
  return await response.json() as { agent: { name: string }; api_key: string };
}

async function board(key: string, slug = `test-board-${++boardNumber}`) {
  const response = await call('/api/boards', { key, body: { slug, title: `Board ${slug}`, description: 'A test board' } });
  assert.equal(response.status, 201);
  return (await response.json() as any).board;
}

async function thread(key: string, slug: string, title = 'A test thread', body = 'An idea worth discussing') {
  const response = await call('/api/threads', { key, body: { board: slug, title, body } });
  assert.equal(response.status, 201);
  return (await response.json() as any).thread;
}

test('static reader, documentation, headers, and missing API routes are served correctly', async () => {
  for (const path of ['/', '/?board=ideas', '/api-docs', '/board.js', '/style.css', '/llms.txt', '/openapi.json']) {
    const response = await call(path);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get('content-security-policy')?.includes("script-src 'self'"), path);
    await response.text();
  }
  const missing = await call('/api/not-a-route');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json() as any).error.code, 'not_found');
  assert.equal((await call('/not-a-page')).status, 404);
  assert.deepEqual(await (await call('/api/health')).json(), { ok: true });
});

test('registration reserves case-normalized names and stores hashes, never raw keys', async () => {
  const response = await call('/api/agents', { body: { name: '  Scout-ONE  ' } });
  assert.equal(response.status, 201);
  const data = await response.json() as any;
  assert.equal(data.agent.name, 'scout-one');
  assert.match(data.api_key, /^ab_[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(data.agent).sort(), ['created_at', 'name']);
  const row = await db.prepare('SELECT key_hash FROM agents WHERE name = ?').bind('scout-one').first() as any;
  assert.match(row.key_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(row.key_hash, data.api_key);
  const duplicate = await call('/api/agents', { body: { name: 'SCOUT-ONE' } });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json() as any).error.code, 'name_taken');
  for (const name of ['ab', '-bad', 'white space', 'agent/escape', 'x'.repeat(33)]) {
    assert.equal((await call('/api/agents', { body: { name } })).status, 400, name);
  }
  const me = await call('/api/me', { key: data.api_key });
  assert.deepEqual(await me.json(), { agent: data.agent });
});

test('simultaneous registration of the same name has one winner', async () => {
  const responses = await Promise.all([
    call('/api/agents', { body: { name: 'concurrent-agent' } }),
    call('/api/agents', { body: { name: 'concurrent-agent' } }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
});

test('account keys are required for every write except registration; POST still uses Bearer auth', async () => {
  const { api_key } = await account();
  for (const [path, body] of [
    ['/api/boards', { slug: 'denied', title: 'Denied' }],
    ['/api/threads', { board: 'ideas', title: 'No auth', body: 'No auth' }],
    ['/api/threads/1/replies', { body: 'No auth' }],
  ] as const) {
    const response = await call(path, { body });
    assert.equal(response.status, 401);
    assert.ok(response.headers.get('www-authenticate')?.includes('Bearer'));
  }
  assert.equal((await call('/api/me/key', { method: 'POST' })).status, 401);
  assert.equal((await call(`/api/me?api_key=${api_key}`)).status, 200);
  assert.equal((await call(`/api/me/key?api_key=${api_key}`, { method: 'POST' })).status, 400);
  assert.equal((await call('/api/me', { key: `ab_${'0'.repeat(64)}` })).status, 401);
  assert.equal((await call('/api/me', { key: 'invalid' })).status, 401);
});

function query(path: string, fields: Record<string, string>) {
  return `${path}?${new URLSearchParams(fields)}`;
}

test('an agent can register, create a board, post, reply, search, read, and rotate using only GET URLs', async () => {
  const registration = await call(query('/api/get/agents', { name: '  Get-Only-Agent  ' }));
  assert.equal(registration.status, 201);
  const { agent, api_key } = await registration.json() as any;
  assert.equal(agent.name, 'get-only-agent');
  const get = (path: string, fields: Record<string, string> = {}) => call(query(path, { api_key, ...fields }));
  const description = 'Ideas + experiments & questions? 🤖';
  const createdBoard = await get('/api/get/boards', { slug: 'GET-ONLY-BOARD', title: 'A GET board', description });
  assert.equal(createdBoard.status, 201);
  assert.equal(createdBoard.headers.get('location'), '/api/boards/get-only-board');
  const { board } = await createdBoard.json() as any;
  assert.equal(board.created_by, agent.name);
  assert.equal(board.description, description);
  const body = 'Café 🤖\nLiteral + & = ? # % / <script> and apostrophe: it\'s fine.';
  const createdThread = await get('/api/get/threads', { board: board.slug, title: 'Getonlysearchable title', body });
  assert.equal(createdThread.status, 201);
  const { thread } = await createdThread.json() as any;
  assert.equal(thread.body, body);
  assert.equal(thread.agent, agent.name);
  const createdReply = await get(`/api/get/threads/${thread.id}/replies`, { body: 'Getreplysearchable response' });
  assert.equal(createdReply.status, 201);
  const { reply } = await createdReply.json() as any;
  assert.equal(reply.parent_id, thread.id);
  assert.equal(reply.board, board.slug);
  assert.equal(reply.agent, agent.name);
  assert.equal(reply.title, '');
  assert.equal(createdReply.headers.get('location'), `/api/threads/${thread.id}`);
  for (const response of [registration, createdBoard, createdThread, createdReply]) {
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  }
  const conversation = await (await call(`/api/threads/${thread.id}`)).json() as any;
  assert.deepEqual(conversation.thread, thread);
  assert.deepEqual(conversation.replies, [reply]);
  for (const q of ['getonlysearch', 'getreplysearch']) {
    const page = await (await call(query('/api/threads', { board: board.slug, q }))).json() as any;
    assert.deepEqual(page.threads.map((row: any) => row.id), [thread.id]);
  }
  assert.deepEqual(await (await get('/api/me')).json(), { agent });
  const rotation = await get('/api/get/me/key');
  assert.equal(rotation.status, 200);
  assert.equal(rotation.headers.get('cache-control'), 'no-store');
  const rotated = await rotation.json() as any;
  assert.notEqual(rotated.api_key, api_key);
  assert.equal((await get('/api/me')).status, 401);
  assert.deepEqual(await (await call(query('/api/me', { api_key: rotated.api_key }))).json(), { agent });
  const row = await db.prepare('SELECT key_hash FROM agents WHERE name = ?').bind(agent.name).first() as any;
  assert.match(row.key_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(row.key_hash, rotated.api_key);
});

test('GET writes enforce authentication, input limits, unique fields, and board/thread ownership rules', async () => {
  const { api_key } = await account();
  const ideas = await board(api_key);
  const first = await thread(api_key, ideas.slug);
  const rootFields = { api_key, board: ideas.slug, title: 'Title', body: 'Body' };
  for (const path of ['/api/get/boards', '/api/get/threads', `/api/get/threads/${first.id}/replies`, '/api/get/me/key']) {
    const response = await call(path);
    assert.equal(response.status, 401, path);
    assert.ok(response.headers.get('www-authenticate')?.includes('Bearer'));
  }
  assert.equal((await call(query('/api/get/agents', { name: 'ab' }))).status, 400);
  assert.equal((await call(query('/api/get/agents', { name: 'get-only-agent' }))).status, 409);
  assert.equal((await call(query('/api/get/boards', { api_key, slug: ideas.slug, title: 'Duplicate' }))).status, 409);
  assert.equal((await call(query('/api/get/boards', { api_key, slug: 'no-title' }))).status, 400);
  assert.equal((await call(query('/api/get/boards', { api_key, slug: 'long-description', title: 'Title', description: 'x'.repeat(501) }))).status, 400);
  for (const fields of [
    { ...rootFields, title: '' },
    { ...rootFields, title: 'x'.repeat(161) },
    { ...rootFields, body: 'x'.repeat(10001) },
    { ...rootFields, body: '\0text' },
    { ...rootFields, agent: 'someone-else' },
    { ...rootFields, unknown: 'field' },
  ]) assert.equal((await call(query('/api/get/threads', fields))).status, 400);
  assert.equal((await call(query('/api/get/threads', rootFields) + '&body=duplicate')).status, 400);
  assert.equal((await call(query('/api/get/threads', rootFields) + '&__proto__=spoof')).status, 400);
  assert.equal((await call(query('/api/get/threads', { ...rootFields, board: 'missing-get-board' }))).status, 404);
  assert.equal((await call(query('/api/get/threads/999999/replies', { api_key, body: 'Missing' }))).status, 404);
  assert.equal((await call(query(`/api/get/threads/${first.id}/replies`, { api_key, body: 'Move', board: 'elsewhere' }))).status, 400);
  assert.equal((await call(query('/api/get/me/key', { api_key, unexpected: 'field' }))).status, 400);
  // Percent encoding expands Unicode; the URL limit applies to encoded bytes.
  const longUrl = await call(query('/api/get/threads', { ...rootFields, body: '🤖'.repeat(1700) }));
  assert.equal(longUrl.status, 414);
  assert.equal((await longUrl.json() as any).error.code, 'url_too_long');
  const count = await db.prepare('SELECT count(*) AS n FROM posts WHERE board = ?').bind(ideas.slug).first() as any;
  assert.equal(count.n, 1);
  const headerReply = await call(query(`/api/get/threads/${first.id}/replies`, { body: 'Bearer works on GET too' }), { key: api_key });
  assert.equal(headerReply.status, 201);
  const { reply } = await headerReply.json() as any;
  assert.equal((await call(query(`/api/get/threads/${reply.id}/replies`, { api_key, body: 'Too deep' }))).status, 404);
  const maxBody = await call(query('/api/get/threads', { ...rootFields, body: 'x'.repeat(10000) }));
  assert.equal(maxBody.status, 201);
  assert.equal((await maxBody.json() as any).thread.body.length, 10000);
});

test('GET authentication rejects ambiguous or malformed credentials without echoing them', async () => {
  const alice = await account();
  const bob = await account();
  const me = query('/api/me', { api_key: alice.api_key });
  for (const path of [me + `&api_key=${alice.api_key}`, me + `&api_key=${bob.api_key}`]) {
    const response = await call(path);
    assert.equal(response.status, 400);
    const text = await response.text();
    assert.ok(!text.includes(alice.api_key) && !text.includes(bob.api_key));
  }
  assert.equal((await call(me, { key: bob.api_key })).status, 400);
  assert.equal((await call(me, { headers: { Authorization: 'invalid' } })).status, 400);
  for (const api_key of ['', 'invalid', `ab_${'0'.repeat(64)}`]) {
    assert.equal((await call(query('/api/me', { api_key }))).status, 401);
  }
  assert.equal((await call(me, { method: 'HEAD' })).status, 200);
});

test('HEAD, OPTIONS, prefetch, unsupported methods, and normal read URLs never perform GET writes', async () => {
  const { api_key } = await account();
  const ideas = await board(api_key);
  const first = await thread(api_key, ideas.slug);
  const paths = [
    query('/api/get/agents', { name: 'never-created-by-head' }),
    query('/api/get/boards', { api_key, slug: 'never-created-by-head', title: 'No write' }),
    query('/api/get/threads', { api_key, board: ideas.slug, title: 'No write', body: 'No write' }),
    query(`/api/get/threads/${first.id}/replies`, { api_key, body: 'No write' }),
    query('/api/get/me/key', { api_key }),
  ];
  const snapshot = () => db.prepare('SELECT (SELECT count(*) FROM agents) AS agents, (SELECT count(*) FROM boards) AS boards, (SELECT count(*) FROM posts) AS posts').first();
  const before = await snapshot();
  for (const path of paths) {
    for (const method of ['HEAD', 'POST', 'PUT', 'DELETE']) {
      const response = await call(path, { method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET, OPTIONS');
      if (method === 'HEAD') assert.equal(await response.text(), '');
    }
    assert.equal((await call(path, { method: 'OPTIONS' })).status, 204);
    for (const headers of [{ Purpose: 'prefetch' }, { 'Sec-Purpose': 'prefetch;prerender' }]) {
      assert.equal((await call(path, { headers })).status, 400);
    }
  }
  assert.equal((await call(query('/api/boards', { api_key, slug: 'not-created', title: 'Read only' }))).status, 200);
  assert.equal((await call(query('/api/threads', { api_key, board: ideas.slug, title: 'Read only', body: 'Read only' }))).status, 200);
  assert.equal((await call('/api/get/not-a-route')).status, 404);
  assert.deepEqual(await snapshot(), before);
  assert.equal((await call(query('/api/me', { api_key }))).status, 200);
});

test('GET and POST writes share one quota, including all five GET write operations', async () => {
  const { api_key } = await account();
  const ip = '198.51.100.43';
  for (let i = 0; i < 10; i++) {
    const name = `mixed-limit-agent-${i}`;
    const response = i % 2
      ? await call('/api/agents', { ip, body: { name } })
      : await call(query('/api/get/agents', { name }), { ip });
    assert.equal(response.status, 201);
  }
  for (const path of ['/api/get/agents', '/api/get/boards', '/api/get/threads', '/api/get/threads/1/replies', '/api/get/me/key', '/api/agents']) {
    const response = await call(path, { ip, method: path === '/api/agents' ? 'POST' : 'GET' });
    assert.equal(response.status, 429, path);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await call(query('/api/me', { api_key }), { ip })).status, 200);
  assert.equal((await call('/api/threads', { ip })).status, 200);
});

test('agents create boards; all accounts can contribute with enforced authorship and nesting', async () => {
  const alice = await account();
  const bob = await account();
  const ideas = await board(alice.api_key, 'organized-ideas');
  assert.equal(ideas.created_by, alice.agent.name);
  assert.equal(ideas.thread_count, 0);
  assert.equal((await call('/api/boards', { key: bob.api_key, body: { slug: 'ORGANIZED-IDEAS', title: 'Duplicate' } })).status, 409);
  const first = await thread(bob.api_key, ideas.slug, 'An organized thought', 'Shared by another account');
  assert.equal(first.agent, bob.agent.name);
  assert.equal(first.board, ideas.slug);
  assert.equal(first.parent_id, null);
  const replyResponse = await call(`/api/threads/${first.id}/replies`, { key: alice.api_key, body: { body: 'Following the thought' } });
  assert.equal(replyResponse.status, 201);
  assert.equal(replyResponse.headers.get('location'), `/api/threads/${first.id}`);
  const { reply } = await replyResponse.json() as any;
  assert.equal(reply.agent, alice.agent.name);
  assert.equal(reply.parent_id, first.id);
  assert.equal(reply.board, ideas.slug);
  assert.equal(reply.title, '');
  const read = await (await call(`/api/threads/${first.id}`)).json() as any;
  assert.deepEqual(read.thread, first);
  assert.deepEqual(read.replies, [reply]);
  assert.equal(read.next_cursor, null);
  assert.equal((await (await call(`/api/boards/${ideas.slug}`)).json() as any).board.thread_count, 1);
  assert.equal((await call(`/api/threads/${reply.id}/replies`, { key: bob.api_key, body: { body: 'Too deep' } })).status, 404);
  assert.equal((await call('/api/threads', { key: bob.api_key, body: { board: ideas.slug, title: 'Spoof', body: 'Spoof', agent: alice.agent.name } })).status, 400);
  assert.equal((await call(`/api/threads/${first.id}/replies`, { key: bob.api_key, body: { body: 'Move', board: 'elsewhere' } })).status, 400);
  assert.equal((await call('/api/threads', { key: bob.api_key, body: { board: 'does-not-exist', title: 'Missing', body: 'Missing' } })).status, 404);
  assert.equal((await call('/api/threads?board=does-not-exist')).status, 404);
  assert.equal((await call('/api/threads/999999')).status, 404);
});

test('full-text search covers thread titles, bodies, replies and names and respects board scope', async () => {
  const agent = await account();
  const left = await board(agent.api_key);
  const right = await board(agent.api_key);
  const first = await thread(agent.api_key, left.slug, 'Quasar architectures', 'Persistent semantic memory');
  const second = await thread(agent.api_key, right.slug, 'Different topic', 'Separate conversation');
  await call(`/api/threads/${second.id}/replies`, { key: agent.api_key, body: { body: 'QUASAR experiments and zebracorn protocols' } });
  for (const [q, ids] of [
    ['quas', [second.id, first.id]],
    ['semantic mem', [first.id]],
    ['zebracorn', [second.id]],
    [agent.agent.name, [second.id, first.id]],
    ['quasar" OR * --', []],
    ['"*()', []],
    ["'; DROP TABLE posts; --", []],
  ] as const) {
    const response = await call(`/api/threads?${new URLSearchParams({ q })}`);
    assert.equal(response.status, 200, q);
    const data = await response.json() as any;
    assert.deepEqual(data.threads.map((item: any) => item.id), ids, q);
  }
  const filtered = await (await call(`/api/threads?${new URLSearchParams({ q: 'quasar', board: left.slug })}`)).json() as any;
  assert.deepEqual(filtered.threads.map((item: any) => item.id), [first.id]);
  assert.equal(filtered.threads[0].reply_count, 0);
  assert.ok('excerpt' in filtered.threads[0]);
  assert.ok(!('body' in filtered.threads[0]));
});

test('thread and reply cursors paginate stably while new messages arrive', async () => {
  const { api_key } = await account();
  const ideas = await board(api_key);
  const threads = [];
  for (let i = 0; i < 3; i++) threads.push(await thread(api_key, ideas.slug, `Page ${i}`, 'paginated searchword'));
  const firstPage = await (await call(`/api/threads?board=${ideas.slug}&q=searchword&limit=2`)).json() as any;
  assert.deepEqual(firstPage.threads.map((item: any) => item.id), [threads[2].id, threads[1].id]);
  assert.equal(firstPage.next_cursor, threads[1].id);
  await thread(api_key, ideas.slug, 'New arrival', 'paginated searchword');
  const lastPage = await (await call(`/api/threads?board=${ideas.slug}&q=searchword&limit=2&before=${firstPage.next_cursor}`)).json() as any;
  assert.deepEqual(lastPage.threads.map((item: any) => item.id), [threads[0].id]);
  assert.equal(lastPage.next_cursor, null);
  const replies = [];
  for (let i = 0; i < 3; i++) {
    const response = await call(`/api/threads/${threads[0].id}/replies`, { key: api_key, body: { body: `Reply ${i}` } });
    replies.push((await response.json() as any).reply);
  }
  const replyPage = await (await call(`/api/threads/${threads[0].id}?limit=2`)).json() as any;
  assert.deepEqual(replyPage.replies.map((item: any) => item.id), [replies[0].id, replies[1].id]);
  const replyLast = await (await call(`/api/threads/${threads[0].id}?limit=2&after=${replyPage.next_cursor}`)).json() as any;
  assert.deepEqual(replyLast.replies.map((item: any) => item.id), [replies[2].id]);
  assert.equal(replyLast.next_cursor, null);
});

test('board directory paginates in slug order and returns accurate thread counts', async () => {
  const { api_key } = await account();
  await board(api_key, 'zzz-paging-c');
  const a = await board(api_key, 'zzz-paging-a');
  await board(api_key, 'zzz-paging-b');
  await thread(api_key, a.slug);
  const page = await (await call('/api/boards?after=zzz&limit=2')).json() as any;
  assert.deepEqual(page.boards.map((item: any) => item.slug), ['zzz-paging-a', 'zzz-paging-b']);
  assert.equal(page.boards[0].thread_count, 1);
  assert.equal(page.next_cursor, 'zzz-paging-b');
  const next = await (await call(`/api/boards?after=${page.next_cursor}&limit=2`)).json() as any;
  assert.deepEqual(next.boards.map((item: any) => item.slug), ['zzz-paging-c']);
  assert.equal(next.next_cursor, null);
});

test('key rotation revokes the old key and retains account ownership', async () => {
  const agent = await account();
  const response = await call('/api/me/key', { method: 'POST', key: agent.api_key });
  assert.equal(response.status, 200);
  const rotated = await response.json() as any;
  assert.notEqual(rotated.api_key, agent.api_key);
  assert.equal((await call('/api/me', { key: agent.api_key })).status, 401);
  const me = await (await call('/api/me', { key: rotated.api_key })).json() as any;
  assert.equal(me.agent.name, agent.agent.name);
  const created = await board(rotated.api_key);
  assert.equal(created.created_by, agent.agent.name);
});

test('input limits, invalid JSON and pagination parameters fail without database changes', async () => {
  const { api_key } = await account();
  const ideas = await board(api_key);
  for (const body of [
    { board: ideas.slug, title: '', body: 'text' },
    { board: ideas.slug, title: 'x'.repeat(161), body: 'text' },
    { board: ideas.slug, title: 'title', body: 'x'.repeat(10001) },
    { board: ideas.slug, title: 'title', body: '\0text' },
    { board: ideas.slug, title: 'title', body: '   ' },
    { board: '../escape', title: 'title', body: 'text' },
  ]) assert.equal((await call('/api/threads', { key: api_key, body })).status, 400);
  assert.equal((await call('/api/boards', { key: api_key, body: { slug: 'null-description', title: 'Title', description: null } })).status, 400);
  for (const raw of ['{', 'null', '[]', '"text"']) {
    assert.equal((await call('/api/agents', { raw, headers: { 'Content-Type': 'application/json' } })).status, 400);
  }
  assert.equal((await call('/api/agents', { raw: '{"name":"wrong-type"}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await call('/api/agents', { raw: JSON.stringify({ name: 'x'.repeat(50000) }), headers: { 'Content-Type': 'application/json' } })).status, 413);
  const streamed = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 3; i++) controller.enqueue(new TextEncoder().encode('x'.repeat(20000)));
      controller.close();
    },
  });
  const oversizedStream = await mf.dispatchFetch('http://board.test/api/agents', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.101' }, body: streamed, duplex: 'half',
  });
  assert.equal(oversizedStream.status, 413);
  for (const path of ['/api/threads?limit=0', '/api/threads?limit=51', '/api/threads?before=-1', '/api/threads?before=9007199254740992', '/api/boards?limit=101', '/api/boards?after=../bad', `/api/threads?q=${'x'.repeat(201)}`]) {
    assert.equal((await call(path)).status, 400, path);
  }
  const text = '<script>alert("agent")</script>\n\nAn apostrophe: it\'s fine.';
  const stored = await thread(api_key, ideas.slug, 'Plain text, literally', text);
  assert.equal((await (await call(`/api/threads/${stored.id}`)).json() as any).thread.body, text);
  const count = await db.prepare('SELECT count(*) AS n FROM posts WHERE board = ?').bind(ideas.slug).first() as any;
  assert.equal(count.n, 1);
});

test('CORS supports Authorization, HEAD has no body, and writes cannot use destructive methods', async () => {
  const preflight = await call('/api/threads', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  assert.ok(preflight.headers.get('access-control-allow-headers')?.includes('Authorization'));
  const head = await call('/api/threads', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(head.headers.get('cache-control'), 'no-store');
  assert.equal((await call('/api/threads/1', { method: 'DELETE' })).status, 405);
});

test('write rate limiting returns a retry interval and does not consume the public read quota', async () => {
  for (let i = 0; i < 10; i++) {
    assert.equal((await call('/api/agents', { ip: '198.51.100.42', body: { name: `limited-agent-${i}` } })).status, 201);
  }
  const limited = await call('/api/agents', { ip: '198.51.100.42', body: { name: 'limited-agent-last' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal((await call('/api/threads', { ip: '198.51.100.42' })).status, 200);
});

test('D1 deletion cascades replies and keeps the full-text index consistent', async () => {
  const { api_key } = await account();
  const ideas = await board(api_key);
  const first = await thread(api_key, ideas.slug, 'Disappearword', 'Cleanup');
  await call(`/api/threads/${first.id}/replies`, { key: api_key, body: { body: 'Disappearword reply' } });
  await db.prepare('DELETE FROM posts WHERE id = ?').bind(first.id).run();
  const remaining = await db.prepare('SELECT count(*) AS n FROM posts WHERE parent_id = ?').bind(first.id).first() as any;
  assert.equal(remaining.n, 0);
  const search = await (await call('/api/threads?q=disappearword')).json() as any;
  assert.deepEqual(search.threads, []);
  const plan = await db.prepare('EXPLAIN QUERY PLAN SELECT id FROM posts WHERE board = ? AND parent_id IS NULL ORDER BY id DESC LIMIT 20').bind(ideas.slug).all();
  assert.ok(plan.results.some((row: any) => row.detail.includes('idx_posts_board_id')));
});
