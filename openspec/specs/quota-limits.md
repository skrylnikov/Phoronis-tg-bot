# Спецификация: Лимиты квот подписок

## Обзор
Определение точных значений лимитов для различных типов квот (премиум-запросы, распознавание изображений, распознавание голоса) для персональных и групповых подписок.

**ВАЖНО:** Лимиты являются финальными значениями для каждого тарифа. Платная подписка **заменяет** бесплатные лимиты, а **не прибавляется** к ним.

## Типы квот

### QuotaKind
- `PRIMARY_RESPONSE` - основные (премиум) запросы к AI
- `IMAGE` - распознавание изображений через vision API
- `VOICE` - распознавание голосовых сообщений
- `ANALYSIS` - анализ контекста (остается Infinity для платных подписок)

### QuotaScope
- `USER` - персональные лимиты пользователя
- `CHAT` - групповые лимиты чата

## Персональные лимиты (personal)

Персональные лимиты **заменяют** бесплатные лимиты при покупке подписки.

### Бесплатные лимиты (freeLimits)
```typescript
const freeLimits: Record<QuotaKind, number> = {
  PRIMARY_RESPONSE: 10,
  IMAGE: 5,
  VOICE: 10,
  ANALYSIS: 1,
};
```

### WEEK (недельная подписка)
```typescript
personal: {
  PRIMARY_RESPONSE: 30,
  IMAGE: 15,
  VOICE: 30,
  ANALYSIS: Infinity
}
```
**Финальные лимиты:** PRIMARY=30, IMAGE=15, VOICE=30

### MONTH (месячная подписка)
```typescript
personal: {
  PRIMARY_RESPONSE: 50,
  IMAGE: 30,
  VOICE: 60,
  ANALYSIS: Infinity
}
```
**Финальные лимиты:** PRIMARY=50, IMAGE=30, VOICE=60

### QUARTER (квартальная подписка)
```typescript
personal: {
  PRIMARY_RESPONSE: 100,
  IMAGE: 50,
  VOICE: 100,
  ANALYSIS: Infinity
}
```
**Финальные лимиты:** PRIMARY=100, IMAGE=50, VOICE=100

### YEAR (годовая подписка)
```typescript
personal: {
  PRIMARY_RESPONSE: 500,
  IMAGE: 200,
  VOICE: 400,
  ANALYSIS: Infinity
}
```
**Финальные лимиты:** PRIMARY=500, IMAGE=200, VOICE=400

## Групповые лимиты (chat)

Групповые лимиты получает **каждый участник** группы отдельно.
Подписки одной группы складываются.

### Закономерность
- **PRIMARY** = **IMAGE** (одинаковые значения)
- **VOICE** = **IMAGE × 2** (в два раза больше)

### WEEK (недельная подписка)
```typescript
chat: {
  PRIMARY_RESPONSE: 3,
  IMAGE: 3,
  VOICE: 6,
  ANALYSIS: 1
}
```

### MONTH (месячная подписка)
```typescript
chat: {
  PRIMARY_RESPONSE: 5,
  IMAGE: 5,
  VOICE: 10,
  ANALYSIS: 3
}
```

### QUARTER (квартальная подписка)
```typescript
chat: {
  PRIMARY_RESPONSE: 10,
  IMAGE: 10,
  VOICE: 20,
  ANALYSIS: 5
}
```

### YEAR (годовая подписка)
```typescript
chat: {
  PRIMARY_RESPONSE: 20,
  IMAGE: 20,
  VOICE: 40,
  ANALYSIS: 10
}
```

## Итоговая таблица личных лимитов в день

| Тариф | PRIMARY_RESPONSE | IMAGE | VOICE |
|-------|------------------|-------|-------|
| Free  | 10               | 5     | 10    |
| Week  | 30               | 15    | 30    |
| Month | 50               | 30    | 60    |
| Quarter | 100            | 50    | 100   |
| Year  | 500              | 200   | 400   |

## Итоговая таблица групповых лимитов в день (на участника)

| Тариф | PRIMARY_RESPONSE | IMAGE | VOICE |
|-------|------------------|-------|-------|
| Week  | 3                | 3     | 6     |
| Month | 5                | 5     | 10    |
| Quarter | 10             | 10    | 20    |
| Year  | 20               | 20    | 40    |

## Логика применения лимитов

### getPersonalDailyLimits
```typescript
export function getPersonalDailyLimits(
  subscriptions: Array<{ plan: SubscriptionPlan }>,
): Record<QuotaKind, number> {
  if (subscriptions.length === 0) {
    return freeLimits;  // Используются только бесплатные лимиты
  }
  return sumLimits(subscriptions, 'personal');  // Только платные лимиты
}
```

Если подписка есть, бесплатные лимиты **не прибавляются**.
Если подписок несколько, их лимиты **складываются**.

## Файлы для обновления

### Обязательные
- `src/shared/quota-service.ts` - константа `freeLimits` и объект `planDetails`
- `src/shared/quota-service.ts` - функция `getPersonalDailyLimits` (убрать сложение с freeLimits)
- `src/shared/subscription-presentation.ts` - текст "прибавляется" → "заменяет"
- `src/__tests__/subscription-pricing.test.ts` - тестовые проверки лимитов
- `src/__tests__/subscription-presentation.test.ts` - ожидаемые значения в презентации

### Дополнительные (проверить на упоминание старых чисел)
- README.md или документация
- Комментарии в коде
- Другие тесты, упоминающие конкретные числа лимитов

## Цены
Цены подписок **НЕ МЕНЯЮТСЯ**:
- WEEK: 49 Stars
- MONTH: 99 Stars
- QUARTER: 199 Stars
- YEAR: 599 Stars

## Критерии приемки
- [ ] `freeLimits` обновлены: PRIMARY=10, IMAGE=5, VOICE=10, ANALYSIS=1
- [ ] `planDetails.WEEK.personal`: PRIMARY=30, IMAGE=15, VOICE=30, ANALYSIS=Infinity
- [ ] `planDetails.MONTH.personal`: PRIMARY=50, IMAGE=30, VOICE=60, ANALYSIS=Infinity
- [ ] `planDetails.QUARTER.personal`: PRIMARY=100, IMAGE=50, VOICE=100, ANALYSIS=Infinity
- [ ] `planDetails.YEAR.personal`: PRIMARY=500, IMAGE=200, VOICE=400, ANALYSIS=Infinity
- [ ] `planDetails.WEEK.chat`: PRIMARY=3, IMAGE=3, VOICE=6, ANALYSIS=1
- [ ] `planDetails.MONTH.chat`: PRIMARY=5, IMAGE=5, VOICE=10, ANALYSIS=3
- [ ] `planDetails.QUARTER.chat`: PRIMARY=10, IMAGE=10, VOICE=20, ANALYSIS=5
- [ ] `planDetails.YEAR.chat`: PRIMARY=20, IMAGE=20, VOICE=40, ANALYSIS=10
- [ ] `getPersonalDailyLimits` не складывает free+paid, возвращает только paid
- [ ] Текст "прибавляется к бесплатным" заменен на "заменяет бесплатные"
- [ ] Все тесты проходят (`bun test` если доступно)
- [ ] `bun run typecheck` проходит без ошибок
