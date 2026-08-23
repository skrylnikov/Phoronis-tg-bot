import { getMoscowDay } from './domain/quota-service';

export interface AnalyticsRuntimeSnapshot {
  vectorSearches: number;
  vectorSearchesWithHits: number;
  contextMessagesAdded: number;
  aiAttempts: number;
  aiSuccesses: number;
  aiFailures: number;
  latencyMs: number[];
  isPartial: boolean;
}

interface AnalyticsRuntimeState extends AnalyticsRuntimeSnapshot {
  day: Date;
}

const processStartedAt = new Date();
let state: AnalyticsRuntimeState = createState(getMoscowDay(processStartedAt));

function createState(day: Date): AnalyticsRuntimeState {
  return {
    day,
    vectorSearches: 0,
    vectorSearchesWithHits: 0,
    contextMessagesAdded: 0,
    aiAttempts: 0,
    aiSuccesses: 0,
    aiFailures: 0,
    latencyMs: [],
    isPartial: processStartedAt > day,
  };
}

function getState(now: Date): AnalyticsRuntimeState {
  const day = getMoscowDay(now);
  if (state.day.getTime() !== day.getTime()) {
    state = createState(day);
  }
  return state;
}

export function recordVectorSearch(
  resultCount: number,
  now = new Date(),
): void {
  const current = getState(now);
  current.vectorSearches += 1;
  if (resultCount > 0) current.vectorSearchesWithHits += 1;
  current.contextMessagesAdded += Math.max(0, resultCount);
}

export function recordAiAttempt(now = new Date()): void {
  getState(now).aiAttempts += 1;
}

export function recordAiSuccess(durationMs: number, now = new Date()): void {
  const current = getState(now);
  current.aiSuccesses += 1;
  current.latencyMs.push(Math.max(0, durationMs));
}

export function recordAiFailure(durationMs: number, now = new Date()): void {
  const current = getState(now);
  current.aiFailures += 1;
  current.latencyMs.push(Math.max(0, durationMs));
}

export function getAnalyticsRuntimeSnapshot(
  now = new Date(),
): AnalyticsRuntimeSnapshot {
  const current = getState(now);
  return {
    vectorSearches: current.vectorSearches,
    vectorSearchesWithHits: current.vectorSearchesWithHits,
    contextMessagesAdded: current.contextMessagesAdded,
    aiAttempts: current.aiAttempts,
    aiSuccesses: current.aiSuccesses,
    aiFailures: current.aiFailures,
    latencyMs: [...current.latencyMs],
    isPartial: current.isPartial,
  };
}

export function resetAnalyticsRuntimeForTests(now = new Date()): void {
  state = createState(getMoscowDay(now));
}
