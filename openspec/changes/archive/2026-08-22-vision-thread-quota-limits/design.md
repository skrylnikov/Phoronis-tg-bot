# Design: Vision Thread Recognition & Quota Limits

## Architecture

### High-Level Components

```
┌─────────────────────────────────────────────────────────────┐
│ Grammy Bot Handlers                                         │
│  ├─ :text handler (process-message.ts)                     │
│  │   ├─ shouldRespond check                                │
│  │   ├─ findPhotoInReplyChain() ← NEW                     │
│  │   ├─ reserveQuota(IMAGE)                                │
│  │   └─ describeTelegramPhoto()                            │
│  └─ :photo handler (process-message.ts)                    │
│      ├─ shouldRespond check ← MOVED EARLIER                │
│      ├─ reserveQuota(IMAGE)                                │
│      └─ describeTelegramPhoto()                            │
└─────────────────────────────────────────────────────────────┘
         ↓                              ↓
┌──────────────────┐          ┌──────────────────────┐
│ Quota Service    │          │ Image Description    │
│ (quota-service)  │          │ (image-description)  │
│                  │          │                      │
│ getPersonalDaily │          │ describeTelegram     │
│ Limits()         │          │ Photo()              │
│ ← CHANGED        │          │                      │
│                  │          │ Vision API (RouterAI)│
└──────────────────┘          └──────────────────────┘
         ↓
┌─────────────────────────────────────┐
│ Database (Prisma)                   │
│  ├─ Message (replyToMessageId, media)│
│  ├─ QuotaUsage (scope, kind, count) │
│  └─ Subscription (plan, userId)     │
└─────────────────────────────────────┘
```

## Data Flow

### 1. Multi-hop Photo Search

```
User C: "ио, что это?" (reply to User B)
  ↓
:text handler
  ↓
findPhotoInReplyChain(ctx, ctx.msg.reply_to_message, maxDepth=10)
  ↓
Loop (depth < 10):
  ├─ Check current.photo → if found, return { photo, messageId }
  ├─ Check current.reply_to_message (Telegram API)
  │   ├─ If present → continue with it
  │   └─ If absent → fetch from DB
  │       ├─ prisma.message.findUnique({ replyToMessageId })
  │       └─ Check media field for image/jpeg
  └─ depth++
  ↓
Return photo or null
```

### 2. Quota Limit Application

```
reserveQuota({ userId, chatId, isGroup, kind })
  ↓
getActiveUserSubscriptions(userId)
  ↓
getPersonalDailyLimits(subscriptions)
  ↓
if (subscriptions.length === 0)
    return freeLimits  ← FREE tier
else
    return sumLimits(subscriptions, 'personal')  ← PAID only
  ↓
reserve(scope, ownerId, chatId, kind, day, limit)
  ↓
INSERT ... ON CONFLICT DO UPDATE
SET count = count + 1
WHERE count < limit
```

## Key Changes

### File: src/controllers/process-message.ts

#### Added: findPhotoInReplyChain()

**Location:** Lines 92-169 (new function)

**Purpose:** Walk reply chain up to maxDepth levels to find photos

**Key Logic:**
- Use Telegram API (`reply_to_message`) when available
- Fall back to DB (`replyToMessageId`) for old messages
- Parse `media` field for `image/jpeg` file_id
- Convert BigInt IDs to Number where needed
- Early exit when photo found or depth exceeded

**Type Signature:**
```typescript
async function findPhotoInReplyChain(
  ctx: BotContext,
  startMessage: {
    message_id: number;
    photo?: PhotoSize[];
    reply_to_message?: {...};
  } | null | undefined,
  maxDepth = 10,
): Promise<{ photo: PhotoSize; messageId: number } | null>
```

#### Modified: :text handler

**Location:** Lines 253-287 (changed)

**Before:**
```typescript
const repliedPhoto = ctx.msg.reply_to_message?.photo;
if (repliedPhoto) {
  const photo = selectOptimalPhoto(repliedPhoto);
  // ...
}
```

**After:**
```typescript
const photoInChain = await findPhotoInReplyChain(
  ctx,
  ctx.msg.reply_to_message,
);
if (photoInChain) {
  // use photoInChain.photo, photoInChain.messageId
  // ...
}
```

**Impact:** Now finds photos multiple hops away in reply chain.

#### Modified: :photo handler

**Location:** Lines 293-363 (reordered)

**Before:**
```typescript
const savedMessage = await saveMessageIfAbsent(...);
const reservation = await reserveQuota(...);  // ← TOO EARLY
// ...
const shouldRespond = ...;
if (shouldRespond) {
  // ...
}
```

**After:**
```typescript
const savedMessage = await saveMessageIfAbsent(...);
const shouldRespond = ...;  // ← MOVED UP
if (!shouldRespond) {
  return;  // No quota wasted
}
const reservation = await reserveQuota(...);  // ← NOW SAFE
// ...
```

**Impact:** Quota only reserved when bot will actually respond.

### File: src/shared/quota-service.ts

#### Modified: freeLimits

**Before:**
```typescript
const freeLimits: Record<QuotaKind, number> = {
  PRIMARY_RESPONSE: 10,
  IMAGE: 5,
  VOICE: 5,  // ← OLD
  ANALYSIS: 1,
};
```

**After:**
```typescript
const freeLimits: Record<QuotaKind, number> = {
  PRIMARY_RESPONSE: 10,
  IMAGE: 5,
  VOICE: 10,  // ← DOUBLED
  ANALYSIS: 1,
};
```

#### Modified: planDetails

**Changes:**
- All personal.VOICE values → IMAGE × 2
- All chat.PRIMARY_RESPONSE values → chat.IMAGE (was smaller)
- All chat.VOICE values → chat.IMAGE × 2

**Example (WEEK):**
```typescript
// Before:
personal: { PRIMARY_RESPONSE: 30, IMAGE: 15, VOICE: 15, ... },
chat: { PRIMARY_RESPONSE: 1, IMAGE: 3, VOICE: 3, ... },

// After:
personal: { PRIMARY_RESPONSE: 30, IMAGE: 15, VOICE: 30, ... },
chat: { PRIMARY_RESPONSE: 3, IMAGE: 3, VOICE: 6, ... },
```

#### Modified: getPersonalDailyLimits()

**Before:**
```typescript
export function getPersonalDailyLimits(
  subscriptions: Array<{ plan: SubscriptionPlan }>,
): Record<QuotaKind, number> {
  const paidLimits = sumLimits(subscriptions, 'personal');
  return Object.fromEntries(
    (Object.keys(freeLimits) as QuotaKind[]).map((kind) => {
      const freeLimit = freeLimits[kind];
      const paidLimit = paidLimits[kind];
      return [kind, freeLimit + paidLimit];  // ← STACKING
    }),
  );
}
```

**After:**
```typescript
export function getPersonalDailyLimits(
  subscriptions: Array<{ plan: SubscriptionPlan }>,
): Record<QuotaKind, number> {
  if (subscriptions.length === 0) {
    return freeLimits;  // ← FREE only
  }
  return sumLimits(subscriptions, 'personal');  // ← PAID only
}
```

**Impact:** Paid plans replace free limits instead of adding to them.

### File: src/shared/subscription-presentation.ts

#### Modified: formatSubscriptionCatalog()

**Before:** "Личный тариф прибавляется к бесплатным лимитам."

**After:** "Личный тариф заменяет бесплатные лимиты."

**Impact:** User-facing copy matches new behavior.

## Database Schema

No schema changes required. Existing tables support new logic:

**Message:**
- `replyToMessageId: bigint | null` - used for reply chain walking
- `media: string | null` - JSON with `{ fileId, mimeType }` for DB-sourced photos
- `summary: string | null` - caches image descriptions

**QuotaUsage:**
- Existing fields unchanged
- ON CONFLICT logic unchanged

## Error Handling

### findPhotoInReplyChain()

**Errors handled:**
- Invalid `media` JSON → catch, skip, continue to next message
- `ctx.api.getFile()` fails → no photo, continue chain
- DB query fails → propagates up (critical error)

**Safety:**
- maxDepth prevents infinite loops
- Null checks for missing messages
- Type guards for BigInt → Number conversion

### :photo handler early return

**Before:** Quota reserved even if `shouldRespond=false` → wasted quota

**After:** Early return before reservation → quota preserved

## Performance Considerations

### findPhotoInReplyChain()

**Best case:** Photo in immediate reply → 0 DB queries, O(1)

**Average case:** Photo 2-3 hops away → 1-2 DB queries, O(depth)

**Worst case:** No photo in 10 levels → 10 DB queries, O(maxDepth)

**Mitigation:**
- maxDepth=10 (reasonable for chat context)
- Early exit when photo found
- Indexed DB query on `chatId_id` unique constraint

### Quota Calculation

**Before:** O(subscriptions) + O(quotaKinds) operations per check

**After:** Same complexity, just different logic (no performance impact)

## Testing Strategy

### Unit Tests

**Modified:**
- `src/__tests__/subscription-pricing.test.ts` - updated expected limits
- `src/__tests__/subscription-presentation.test.ts` - updated expected text

**Could Add (not implemented):**
- Mock 3-hop reply chain scenario
- Test DB fallback for missing reply_to_message
- Test maxDepth limit enforcement

### Integration Tests

**Manual verification needed:**
- Post photo A → reply B (text) → reply C ("ио...") → bot finds photo A
- Post photo without "ио" → bot ignores (no quota wasted)
- User with WEEK plan → check limits are exactly 30/15/30 (not 40/20/20)

## Deployment

**Status:** Already deployed in PR #7

**Rollout:** No special considerations (backward compatible)

**Monitoring:** Check QuotaUsage table for anomalies after deploy
