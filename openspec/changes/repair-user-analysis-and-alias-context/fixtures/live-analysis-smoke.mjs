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
const { bot } = await import(`${root}/src/bot.ts`);
bot.botInfo = {
  id: 999,
  is_bot: true,
  first_name: 'SmokeBot',
  username: 'smoke_bot',
};
const { analyzeUserMessagesForUser } = await import(
  `${root}/src/application/user-message-analysis.ts`
);
const {
  claimNextBackgroundJobRepo,
  completeBackgroundJobRepo,
  deferAnalysisJobRepo,
} = await import(`${root}/src/repositories/background-job-repository.ts`);
const { findUserAliasesRepo } = await import(
  `${root}/src/repositories/user-alias-repository.ts`
);
const { getAliasContext } = await import(`${root}/src/ai/alias-context.ts`);
const { applyOwnerAliasCommand } = await import(
  `${root}/src/domain/user/owner-alias.ts`
);
const userId = BigInt(Date.now()),
  authorId = userId + 1n,
  chatId = -userId;
const jobIds = [];
try {
  await prisma.user.createMany({
    data: [
      { id: userId, firstName: 'Передописец' },
      { id: authorId, firstName: 'Автор' },
      { id: 999n, firstName: 'SmokeBot' },
    ],
    skipDuplicates: true,
  });
  await prisma.chat.create({
    data: {
      id: chatId,
      title: 'Synthetic real provider smoke',
      chatType: 'GROUP',
    },
  });
  const cutoffAt = new Date();
  await prisma.message.createMany({
    data: Array.from({ length: 30 }, (_, i) => ({
      chatId,
      id: BigInt(i + 1),
      senderId: userId,
      sentAt: new Date(cutoffAt.getTime() - 60000 + i),
      private: false,
      messageType: 'TEXT',
      text:
        i === 0
          ? 'Мой псевдоним в этом чате — Дима. Под псевдонимом Дима здесь пишу я. Я люблю Rust.'
          : 'Ок, спасибо.',
    })),
  });
  await prisma.message.create({
    data: {
      chatId,
      id: 31n,
      senderId: authorId,
      sentAt: new Date(cutoffAt.getTime() - 100),
      private: false,
      messageType: 'TEXT',
      text: 'Дима, привет! Это я обращаюсь к тебе по твоему имени.',
      replyToMessageId: 1n,
    },
  });
  const row = await prisma.backgroundJob.create({
    data: {
      type: 'USER_MESSAGE_ANALYSIS',
      dedupeKey: `live-smoke:${String(chatId)}`,
      createdAt: cutoffAt,
      payload: {
        chatId: String(chatId),
        userId: String(userId),
        isGroup: true,
      },
    },
  });
  jobIds.push(row.id);
  let job = await claimNextBackgroundJobRepo('live-smoke', 600000);
  assert.equal(job?.id, row.id);
  const result = await analyzeUserMessagesForUser(
    { chatId: Number(chatId), userId: Number(userId), isGroup: true },
    job,
  );
  assert.equal(result.outcome, 'analyzed');
  const aliases = await findUserAliasesRepo(chatId, userId),
    facts = await prisma.userFact.findMany({ where: { userId } });
  console.log(
    JSON.stringify({
      event: 'smoke.acceptance',
      jobOutcome: result.outcome,
      factCount: facts.length,
      aliases: aliases.map((a) => ({
        alias: a.alias,
        status: a.status,
        evidenceCount: a.confirmationCount,
        confidence: a.confidence,
      })),
      requests: timings,
    }),
  );
  assert(facts.length > 0, 'No real fact saved');
  assert(
    aliases.some((a) => a.alias === 'Дима'),
    'No verified alias saved',
  );
  const before = await prisma.userAliasEvidence.count({
    where: { sourceChatId: chatId },
  });
  await prisma.backgroundJob.update({
    where: { id: job.id },
    data: {
      leaseUntil: new Date(Date.now() - 1000),
    },
  });
  job = await claimNextBackgroundJobRepo('live-smoke-restarted', 600000);
  assert.equal(job.id, row.id);
  assert.equal(job.attempts, 2);
  assert.equal(job.createdAt.getTime(), cutoffAt.getTime());
  const requestsBeforeDeferral = timings.length;
  const deferred = await analyzeUserMessagesForUser(
    { chatId: Number(chatId), userId: Number(userId), isGroup: true },
    job,
  );
  assert.equal(deferred.outcome, 'quota_deferred');
  assert.equal(timings.length, requestsBeforeDeferral);
  assert(await deferAnalysisJobRepo(job.id, job.workerId, deferred.deferUntil));
  const pending = await prisma.backgroundJob.findUniqueOrThrow({
    where: { id: job.id },
  });
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.attempts, 1);
  assert.equal(pending.availableAt.getTime(), deferred.deferUntil.getTime());
  console.log(
    JSON.stringify({
      event: 'smoke.partial_save_and_quota',
      persistedFactCount: facts.length,
      status: pending.status,
      attempts: pending.attempts,
      providerCallsOnDeferral: 0,
    }),
  );
  await prisma.quotaUsage.deleteMany({ where: { ownerId: userId } });
  await prisma.backgroundJob.update({
    where: { id: job.id },
    data: { availableAt: new Date() },
  });
  job = await claimNextBackgroundJobRepo('live-smoke-restarted', 600000);
  const retried = await analyzeUserMessagesForUser(
    { chatId: Number(chatId), userId: Number(userId), isGroup: true },
    {
      ...job,
      payload: (
        await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } })
      ).payload,
    },
  );
  assert.equal(retried.outcome, 'analyzed');
  assert.equal(
    await prisma.userFact.count({ where: { userId } }),
    facts.length,
  );
  assert.equal(
    await prisma.userAliasEvidence.count({ where: { sourceChatId: chatId } }),
    before,
  );
  await completeBackgroundJobRepo(job.id, job.workerId);
  const cutoff2 = new Date(Date.now() + 1000);
  await prisma.message.createMany({
    data: Array.from({ length: 30 }, (_, i) => ({
      chatId,
      id: BigInt(32 + i),
      senderId: userId,
      sentAt: new Date(cutoff2.getTime() - 500 + i),
      private: false,
      messageType: 'TEXT',
      text: 'Добрый день, спасибо за ответ.',
    })),
  });
  await prisma.message.create({
    data: {
      chatId,
      id: 62n,
      senderId: authorId,
      sentAt: new Date(cutoff2.getTime() - 100),
      private: false,
      messageType: 'TEXT',
      text: 'Дима, привет! Я точно знаю твой псевдоним: Дима. В этом сообщении обращаюсь именно к тебе по псевдониму Дима.',
      replyToMessageId: 32n,
    },
  });
  const row2 = await prisma.backgroundJob.create({
    data: {
      type: 'USER_MESSAGE_ANALYSIS',
      dedupeKey: `live-smoke-second:${String(chatId)}`,
      createdAt: cutoff2,
      payload: {
        chatId: String(chatId),
        userId: String(userId),
        isGroup: true,
        windowVersion: 1,
        cutoffAt: cutoff2.toISOString(),
        baseMessageIds: Array.from({ length: 30 }, (_, i) => String(32 + i)),
      },
    },
  });
  jobIds.push(row2.id);
  await prisma.quotaUsage.deleteMany({ where: { ownerId: userId } });
  const job2 = await claimNextBackgroundJobRepo('live-smoke', 600000);
  assert.equal(job2?.id, row2.id);
  await analyzeUserMessagesForUser(
    { chatId: Number(chatId), userId: Number(userId), isGroup: true },
    job2,
  );
  await completeBackgroundJobRepo(job2.id, job2.workerId);
  const confirmed = (await findUserAliasesRepo(chatId, userId)).find(
    (a) => a.alias === 'Дима',
  );
  console.log(
    JSON.stringify({
      event: 'smoke.independent',
      status: confirmed?.status,
      authorCount: confirmed?.authorCount,
      evidenceCount: confirmed?.confirmationCount,
      confidence: confirmed?.confidence,
    }),
  );
  if (confirmed?.status !== 'CONFIRMED') process.exitCode = 2; // Open live acceptance gate.
  const ctx = {
    chatId: Number(chatId),
    from: { id: Number(userId), first_name: 'Передописец' },
    msg: { message_id: 100, text: 'называй меня Саша' },
  };
  const preferred = await applyOwnerAliasCommand(ctx);
  assert.equal(preferred.outcome, 'applied');
  assert.equal(
    (
      await getAliasContext(chatId, {
        id: userId,
        firstName: 'Передописец',
        userName: null,
      })
    ).addressing,
    'Саша',
  );
  console.log(
    JSON.stringify({
      event: 'smoke.retry_and_owner',
      evidenceCount: before,
      ownerOutcome: preferred.outcome,
      addressing: 'Саша',
    }),
  );
  const { verifyCandidates } = await import(
    `${root}/src/domain/user/verify-candidates.ts`
  );
  await prisma.message.create({
    data: {
      chatId,
      id: 63n,
      senderId: authorId,
      sentAt: new Date(),
      private: false,
      messageType: 'TEXT',
      text: 'Передай Диме привет.',
      replyToMessageId: 32n,
    },
  });
  const negative = await verifyCandidates(
    [
      {
        id: 'negative',
        kind: 'alias',
        userId,
        content: 'Дима',
        source: {
          chatId,
          messageId: 63n,
          authorId,
          text: 'Передай Диме привет.',
          replyMessageId: 32n,
          replyAuthorId: userId,
          replyText: 'Добрый день, спасибо за ответ.',
        },
      },
    ],
    'negative-smoke',
    999n,
  );
  assert.equal(negative[0].accepted, false);
  console.log(
    JSON.stringify({
      event: 'smoke.third_person',
      probability: negative[0].probability,
      accepted: negative[0].accepted,
    }),
  );
  const { buildAiThreadContext } = await import(
    `${root}/src/ai/thread-context.ts`
  );
  const threadId = `live-smoke-thread:${String(chatId)}`;
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
  assert(stored, 'Missing real compaction boundary');
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
    JSON.stringify({ event: 'smoke.compaction', states, restarted: true }),
  );
  await prisma.aiThreadContext.delete({ where: { id: threadId } });
} catch (error) {
  console.log(
    JSON.stringify({
      event: 'smoke.failure',
      type: error.name,
      message: error.message?.startsWith('analysis:')
        ? error.message
        : 'acceptance failed',
    }),
  );
  process.exitCode = 1;
} finally {
  await prisma.backgroundJob.deleteMany({ where: { id: { in: jobIds } } });
  await prisma.userFact.deleteMany({ where: { userId } });
  await prisma.quotaUsage.deleteMany({ where: { ownerId: userId } });
  await prisma.message.deleteMany({ where: { chatId } });
  await prisma.chat.delete({ where: { id: chatId } });
  await prisma.user.deleteMany({ where: { id: { in: [userId, authorId] } } });
  await prisma.$disconnect();
}
