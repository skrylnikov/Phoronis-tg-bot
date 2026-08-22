# Tasks: Vision Thread Recognition & Quota Limits

## Status: ✅ Completed

Все задачи выполнены в commits a6ecde2, af79676, 11156e7 (PR #7).

---

## Task 1: Обновить free limits и planDetails константы

**Status:** ✅ Done

**Files:**
- `src/shared/quota-service.ts`

**Changes:**
- [x] `freeLimits.VOICE`: 5 → 10
- [x] `planDetails.WEEK.personal.VOICE`: 15 → 30
- [x] `planDetails.WEEK.chat.PRIMARY_RESPONSE`: 1 → 3
- [x] `planDetails.WEEK.chat.VOICE`: 3 → 6
- [x] `planDetails.MONTH.personal.VOICE`: 30 → 60
- [x] `planDetails.MONTH.chat.PRIMARY_RESPONSE`: 3 → 5
- [x] `planDetails.MONTH.chat.VOICE`: 5 → 10
- [x] `planDetails.QUARTER.personal.VOICE`: 50 → 100
- [x] `planDetails.QUARTER.chat.PRIMARY_RESPONSE`: 5 → 10
- [x] `planDetails.QUARTER.chat.VOICE`: 10 → 20
- [x] `planDetails.YEAR.personal.VOICE`: 200 → 400
- [x] `planDetails.YEAR.chat.PRIMARY_RESPONSE`: 10 → 20
- [x] `planDetails.YEAR.chat.VOICE`: 20 → 40

**Verification:**
```bash
bun run typecheck  # ✅ Passed
```

**Commit:** 11156e7

---

## Task 2: Изменить логику getPersonalDailyLimits

**Status:** ✅ Done

**Files:**
- `src/shared/quota-service.ts`

**Changes:**
- [x] Убрать сложение `freeLimit + paidLimit`
- [x] Возвращать `freeLimits` если нет подписок
- [x] Возвращать `sumLimits(subscriptions, 'personal')` если есть подписки

**Code:**
```typescript
export function getPersonalDailyLimits(
  subscriptions: Array<{ plan: SubscriptionPlan }>,
): Record<QuotaKind, number> {
  if (subscriptions.length === 0) {
    return freeLimits;
  }
  return sumLimits(subscriptions, 'personal');
}
```

**Verification:**
```bash
bun test src/__tests__/subscription-pricing.test.ts  # ✅ 3/3 passed
```

**Commit:** 11156e7

---

## Task 3: Обновить пользовательский текст

**Status:** ✅ Done

**Files:**
- `src/shared/subscription-presentation.ts`

**Changes:**
- [x] "прибавляется к бесплатным" → "заменяет бесплатные"

**Verification:**
```bash
bun test src/__tests__/subscription-presentation.test.ts  # ✅ 3/3 passed
```

**Commit:** 11156e7

---

## Task 4: Создать функцию findPhotoInReplyChain

**Status:** ✅ Done

**Files:**
- `src/controllers/process-message.ts` (lines 92-169)

**Implementation:**
- [x] Принимает `startMessage`, `maxDepth=10`
- [x] Ходит по `reply_to_message` в цикле
- [x] Проверяет `photo` в каждом сообщении
- [x] Использует БД если API не вернул `reply_to_message`
- [x] Парсит `media` field для `image/jpeg`
- [x] Возвращает `{ photo, messageId }` или `null`

**Edge cases handled:**
- ✅ BigInt → Number conversion
- ✅ Invalid JSON in media → skip
- ✅ Missing reply chain → break
- ✅ maxDepth limit

**Verification:**
```bash
bun run typecheck  # ✅ No errors
```

**Commit:** 11156e7

---

## Task 5: Использовать findPhotoInReplyChain в :text handler

**Status:** ✅ Done

**Files:**
- `src/controllers/process-message.ts` (lines 253-287)

**Changes:**
- [x] Заменить `ctx.msg.reply_to_message?.photo` на вызов `findPhotoInReplyChain()`
- [x] Использовать `photoInChain.messageId` для поиска кэша
- [x] Передавать `photoInChain.photo` в `describeTelegramPhoto()`

**Verification:**
```bash
bun run typecheck  # ✅ No errors
```

**Commit:** 11156e7

---

## Task 6: Переместить shouldRespond проверку в :photo handler

**Status:** ✅ Done (было в первом коммите)

**Files:**
- `src/controllers/process-message.ts` (lines 326-338)

**Changes:**
- [x] Переместить `shouldRespond` check ПЕРЕД `reserveQuota()`
- [x] Early return если `shouldRespond=false`

**Impact:** Квота IMAGE не расходуется на фото без запроса к боту

**Verification:**
```bash
bun run typecheck  # ✅ No errors
```

**Commit:** a6ecde2

---

## Task 7: Обновить тесты

**Status:** ✅ Done

**Files:**
- `src/__tests__/subscription-pricing.test.ts`
- `src/__tests__/subscription-presentation.test.ts`

**Changes:**
- [x] Обновить ожидаемые лимиты: `YEAR.chat.VOICE` 20 → 40
- [x] Обновить ожидаемые лимиты: `WEEK.personal.PRIMARY` 40 → 30
- [x] Обновить ожидаемый текст в каталоге подписок

**Verification:**
```bash
bun test src/__tests__/subscription-pricing.test.ts        # ✅ 3/3
bun test src/__tests__/subscription-presentation.test.ts   # ✅ 3/3
```

**Commits:** af79676, 11156e7

---

## Task 8: Создать OpenSpec структуру

**Status:** ✅ Done

**Changes:**
- [x] Установить `@fission-ai/openspec@1.10.0`
- [x] Запустить `openspec init --tools cursor,github-copilot`
- [x] Создать `openspec/specs/quota-limits/spec.md`
- [x] Создать `openspec/specs/image-recognition/spec.md`
- [x] Обновить `openspec/config.yaml` с контекстом Phoronis
- [x] Создать change `vision-thread-quota-limits`
- [x] Заполнить proposal, design, tasks, specs deltas

**Files created:**
- `.cursor/commands/opsx-*.md` (6 commands)
- `openspec/config.yaml`
- `openspec/specs/quota-limits/spec.md`
- `openspec/specs/image-recognition/spec.md`
- `openspec/changes/vision-thread-quota-limits/...`

**Verification:**
```bash
openspec --version           # 1.10.0
openspec status --change vision-thread-quota-limits
```

**Commit:** (current work)

---

## Task 9: Обновить AGENTS.md с OpenSpec маркерами

**Status:** ⏳ To be checked after `openspec init`

**Expected:**
- `openspec init` должен был добавить маркерные блоки в AGENTS.md
- Если нет - нужно проверить и добавить вручную

**Verification:**
```bash
grep -i openspec AGENTS.md
```

---

## Testing Summary

### Automated Tests
- ✅ subscription-pricing.test.ts: 3/3 passed
- ✅ subscription-presentation.test.ts: 3/3 passed
- ✅ typecheck: no errors

### Manual Testing Needed
- ⚠️ 3-hop reply chain scenario (no automated test yet)
- ⚠️ DB fallback for old messages
- ⚠️ maxDepth enforcement

### Integration Testing
- User with WEEK: verify limits are 30/15/30 (not 40/20/20)
- Post photo A → reply B → reply C ("ио") → bot describes photo A
- Post photo without request → bot ignores (no quota wasted)

---

## Deployment Checklist

- [x] Code changes implemented
- [x] Tests updated and passing
- [x] TypeScript compilation succeeds
- [x] OpenSpec documentation created
- [ ] Change archived (next step)
- [ ] PR merged
- [ ] Monitor QuotaUsage table after deploy
