# Спецификация: Лимиты квот подписок

## Обзор
Определение точных значений лимитов для различных типов квот (премиум-запросы, распознавание изображений, распознавание голоса) для персональных и групповых подписок.

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

Персональные лимиты **прибавляются** к бесплатным лимитам.

### Бесплатные лимиты (freeLimits)
```typescript
const freeLimits: Record<QuotaKind, number> = {
  PRIMARY_RESPONSE: 10,  // было: 3
  IMAGE: 5,              // было: 3
  VOICE: 5,              // было: 3
  ANALYSIS: 1,
};
```

### WEEK (недельная подписка)
```typescript
personal: {
  PRIMARY_RESPONSE: 30,  // было: 10
  IMAGE: 15,             // было: 5
  VOICE: 15,             // было: 5
  ANALYSIS: Infinity
}
```
**Итоговые лимиты:** PRIMARY=40, IMAGE=20, VOICE=20

### MONTH (месячная подписка)
```typescript
personal: {
  PRIMARY_RESPONSE: 50,  // было: 25
  IMAGE: 30,             // было: 15
  VOICE: 30,             // было: 15
  ANALYSIS: Infinity
}
```
**Итоговые лимиты:** PRIMARY=60, IMAGE=35, VOICE=35

### QUARTER (квартальная подписка)
```typescript
personal: {
  PRIMARY_RESPONSE: 100, // было: 50
  IMAGE: 50,             // было: 30
  VOICE: 50,             // было: 30
  ANALYSIS: Infinity
}
```
**Итоговые лимиты:** PRIMARY=110, IMAGE=55, VOICE=55

### YEAR (годовая подписка)
```typescript
personal: {
  PRIMARY_RESPONSE: 500, // было: 100
  IMAGE: 200,            // было: 100
  VOICE: 200,            // было: 100
  ANALYSIS: Infinity
}
```
**Итоговые лимиты:** PRIMARY=510, IMAGE=205, VOICE=205

## Групповые лимиты (chat)

Групповые лимиты получает **каждый участник** группы отдельно.
Подписки одной группы складываются.

### WEEK (недельная подписка)
```typescript
chat: {
  PRIMARY_RESPONSE: 1,  // без изменений
  IMAGE: 3,             // было: 1
  VOICE: 3,             // было: 1
  ANALYSIS: 1
}
```

### MONTH (месячная подписка)
```typescript
chat: {
  PRIMARY_RESPONSE: 3,  // без изменений
  IMAGE: 5,             // было: 3
  VOICE: 5,             // было: 3
  ANALYSIS: 3
}
```

### QUARTER (квартальная подписка)
```typescript
chat: {
  PRIMARY_RESPONSE: 5,  // без изменений
  IMAGE: 10,            // было: 5
  VOICE: 10,            // было: 5
  ANALYSIS: 5
}
```

### YEAR (годовая подписка)
```typescript
chat: {
  PRIMARY_RESPONSE: 10, // без изменений
  IMAGE: 20,            // было: 10
  VOICE: 20,            // было: 10
  ANALYSIS: 10
}
```

## Итоговая таблица личных лимитов в день

| Тариф | PRIMARY_RESPONSE | IMAGE | VOICE |
|-------|------------------|-------|-------|
| Free  | 10               | 5     | 5     |
| Week  | 40 (10+30)       | 20 (5+15) | 20 (5+15) |
| Month | 60 (10+50)       | 35 (5+30) | 35 (5+30) |
| Quarter | 110 (10+100)   | 55 (5+50) | 55 (5+50) |
| Year  | 510 (10+500)     | 205 (5+200) | 205 (5+200) |

## Итоговая таблица групповых лимитов в день (на участника)

| Тариф | PRIMARY_RESPONSE | IMAGE | VOICE |
|-------|------------------|-------|-------|
| Week  | 1                | 3     | 3     |
| Month | 3                | 5     | 5     |
| Quarter | 5              | 10    | 10    |
| Year  | 10               | 20    | 20    |

## Файлы для обновления

### Обязательные
- `src/shared/quota-service.ts` - константа `freeLimits` и объект `planDetails`
- `src/__tests__/subscription-pricing.test.ts` - тестовые проверки лимитов
- `src/shared/subscription-presentation.ts` - описания для пользователя (если упоминаются числа)

### Дополнительные (проверить на упоминание старых чисел)
- README.md или документация
- Комментарии в коде
- Другие тесты, упоминающие конкретные числа лимитов

## Цены
Цены подписок **НЕ МЕНЯЮТСЯ**, если они не вычисляются автоматически из лимитов:
- WEEK: 49 Stars
- MONTH: 99 Stars
- QUARTER: 199 Stars
- YEAR: 599 Stars

## Критерии приемки
- [ ] `freeLimits` обновлены: PRIMARY=10, IMAGE=5, VOICE=5
- [ ] `planDetails.WEEK.personal` обновлены: PRIMARY=30, IMAGE=15, VOICE=15
- [ ] `planDetails.MONTH.personal` обновлены: PRIMARY=50, IMAGE=30, VOICE=30
- [ ] `planDetails.QUARTER.personal` обновлены: PRIMARY=100, IMAGE=50, VOICE=50
- [ ] `planDetails.YEAR.personal` обновлены: PRIMARY=500, IMAGE=200, VOICE=200
- [ ] `planDetails.WEEK.chat` обновлены: IMAGE=3, VOICE=3
- [ ] `planDetails.MONTH.chat` обновлены: IMAGE=5, VOICE=5
- [ ] `planDetails.QUARTER.chat` обновлены: IMAGE=10, VOICE=10
- [ ] `planDetails.YEAR.chat` обновлены: IMAGE=20, VOICE=20
- [ ] Все тесты проходят (`bun test` если доступно)
- [ ] `bun run typecheck` проходит без ошибок
- [ ] Пользовательские описания обновлены (если содержали старые числа)
