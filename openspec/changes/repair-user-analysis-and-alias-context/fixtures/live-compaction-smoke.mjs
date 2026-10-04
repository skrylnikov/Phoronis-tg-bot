import { strict as assert } from 'node:assert';

const root = process.cwd();
const databaseURL = new URL(
  process.env.DATABASE_URL ?? 'postgresql://localhost/unconfigured',
);
assert.equal(process.env.RUN_ANALYSIS_DB_TESTS, '1');
assert.equal(databaseURL.hostname, '127.0.0.1');
assert.equal(databaseURL.pathname, '/phoronis_alias_test');
assert(
  process.env.PHORONIS_SMOKE_POD && process.env.PHORONIS_SMOKE_KUBECONFIG,
  'Set explicit remote pod and kubeconfig',
);
for (const name of [
  'TOKEN',
  'OPEN_WEATHER_TOKEN',
  'YANDEX_CLOUD_TOKEN',
  'YANDEX_S3_ID',
  'YANDEX_S3_SECRET',
  'ROUTERAI_API_KEY',
  'PAYMENT_SUPPORT_CONTACT',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_PUBLIC_KEY',
])
  process.env[name] ||= name === 'TOKEN' ? '999:smoke' : 'smoke';
process.env.ANALYTICS_CHAT_ID ||= '1';
process.env.EMBEDDING_BASE_URL = 'http://embedding-smoke';
// kubectl transport overhead is measured separately from the native 2s TEI smoke.
process.env.EMBEDDING_TIMEOUT_MS = '20000';
const remoteCode = `const input=await Bun.stdin.json();const url=input.kind==='embedding'?process.env.EMBEDDING_BASE_URL.replace(/\\/+$/,'')+'/embed':'https://routerai.ru/api/v1/'+input.path;const headers={'content-type':'application/json',...(input.kind==='router'?{authorization:'Bearer '+process.env.ROUTERAI_API_KEY}:{})};try{const r=await fetch(url,{method:'POST',headers,body:input.body,signal:AbortSignal.timeout(input.kind==='embedding'?2000:60000)});console.log(JSON.stringify({status:r.status,body:await r.text()}));}catch(error){console.log(JSON.stringify({status:599,body:JSON.stringify({error:{message:'Remote '+error.name}})}));}`;
const timings = [];
globalThis.fetch = async (input, init) => {
  const url = String(input),
    kind = url.startsWith('http://embedding-smoke') ? 'embedding' : 'router';
  if (kind === 'router' && !url.startsWith('https://routerai.ru/api/v1/'))
    throw new Error('Unexpected smoke endpoint');
  const started = performance.now();
  const child = Bun.spawn(
    [
      'rtk',
      'proxy',
      'kubectl',
      '--kubeconfig',
      process.env.PHORONIS_SMOKE_KUBECONFIG,
      '--request-timeout=90s',
      '-n',
      'phoronis',
      'exec',
      '-i',
      process.env.PHORONIS_SMOKE_POD,
      '-c',
      'bot',
      '--',
      'bun',
      '-e',
      remoteCode,
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  );
  child.stdin.write(
    JSON.stringify({
      kind,
      path: kind === 'router' ? url.split('/api/v1/')[1] : '',
      body: init?.body,
    }),
  );
  child.stdin.end();
  const signal = init?.signal;
  const abort = () => child.kill();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) throw new Error('Smoke bridge failed');
    const response = JSON.parse(output);
    timings.push({
      kind,
      path: kind === 'router' ? url.split('/api/v1/')[1] : 'embed',
      durationMs: Math.round(performance.now() - started),
      status: response.status,
    });
    return new Response(response.body, {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  } finally {
    signal?.removeEventListener('abort', abort);
  }
};
const { prisma } = await import(`${root}/src/db.ts`);
const { getAliasContext } = await import(`${root}/src/ai/alias-context.ts`);
const { applyOwnerAliasCommand } = await import(
  `${root}/src/domain/user/owner-alias.ts`
);
const { buildAiThreadContext } = await import(
  `${root}/src/ai/thread-context.ts`
);
const userId = BigInt(Date.now()),
  chatId = -userId,
  threadId = `live-compaction:${String(chatId)}`;
try {
  await prisma.user.create({ data: { id: userId, firstName: 'Передописец' } });
  await prisma.chat.create({
    data: { id: chatId, title: 'Synthetic compaction', chatType: 'GROUP' },
  });
  const ctx = {
    chatId: Number(chatId),
    from: { id: Number(userId), first_name: 'Передописец' },
  };
  for (const [index, name] of ['Саша', 'Шурик', 'Саша', 'Шурик'].entries()) {
    await applyOwnerAliasCommand({
      ...ctx,
      msg: { message_id: 101 + index, text: `называй меня ${name}` },
    });
    const aliasContext = await getAliasContext(chatId, {
      id: userId,
      firstName: 'Передописец',
      userName: null,
    });
    await buildAiThreadContext({
      threadId,
      chatId,
      turnId: `owner-${index}`,
      rules: 'Synthetic rules',
      time: 'now',
      userContext: { users: [{ id: String(userId), aliasContext }] },
      currentUserMessage: { role: 'user', content: 'Привет' },
    });
  }
  const userContext = {
    users: [
      {
        id: String(userId),
        aliasContext: await getAliasContext(chatId, {
          id: userId,
          firstName: 'Передописец',
          userName: null,
        }),
      },
    ],
  };
  await buildAiThreadContext({
    threadId,
    chatId,
    turnId: 'compact',
    rules: 'Synthetic rules',
    time: 'now',
    userContext,
    currentUserMessage: {
      role: 'user',
      content: 'Разговор об именах. '.repeat(3000),
    },
  });
  const stored = await prisma.aiThreadContextEvent.findFirst({
    where: { threadId, eventKind: 'CACHE_BOUNDARY' },
    orderBy: { sequence: 'desc' },
  });
  assert(stored);
  const states = stored.payload.userContexts.map(
    (c) => c.data.users[0].aliasContext.addressing,
  );
  assert.deepEqual(states, ['Саша', 'Шурик', 'Саша', 'Шурик']);
  const restarted = await buildAiThreadContext({
    threadId,
    chatId,
    turnId: 'restart',
    rules: 'Different rules',
    time: 'now',
    userContext,
    currentUserMessage: { role: 'user', content: 'После рестарта' },
  });
  assert(
    JSON.stringify(restarted.messages).lastIndexOf('Шурик') >
      JSON.stringify(restarted.messages).lastIndexOf('Саша'),
  );
  console.log(
    JSON.stringify({
      event: 'smoke.compaction',
      states,
      restarted: true,
      requests: timings,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      event: 'smoke.failure',
      type: error.name,
      message: 'compaction acceptance failed',
    }),
  );
  process.exitCode = 1;
} finally {
  await prisma.aiThreadContext.deleteMany({ where: { id: threadId } });
  await prisma.chat.delete({ where: { id: chatId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
}
