import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteObject: vi.fn(),
  loggerError: vi.fn(),
  putObject: vi.fn(),
  signal: undefined as AbortSignal | undefined,
}));

vi.mock('s3mini', () => ({
  S3mini: class {
    deleteObject = mocks.deleteObject;
    putObject = mocks.putObject;
  },
}));
vi.mock('../config', () => ({
  yandexCloudToken: 'cloud-token',
  yandexS3ID: 's3-id',
  yandexS3Secret: 's3-secret',
}));
vi.mock('../logger', () => ({
  logger: { error: mocks.loggerError },
}));
vi.mock('../update-signal', () => ({
  currentUpdateAbortSignal: vi.fn(() => mocks.signal),
}));

import { speechkit } from '../yandex/speechkit';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  });
}

function completedOperation(text = 'Распознано') {
  return {
    id: 'operation-1',
    done: true,
    response: { chunks: [{ alternatives: [{ text }] }] },
  };
}

async function runLongRecognition() {
  const recognition = speechkit.recognize({
    file: Buffer.from('voice'),
    duration: 30,
  });
  await vi.runAllTimersAsync();
  return recognition;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.signal = undefined;
  mocks.putObject.mockResolvedValue(new Response());
  mocks.deleteObject.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SpeechKit object lifecycle', () => {
  it('uses unique object keys and deletes them after success', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ id: 'operation-1', done: false }))
        .mockResolvedValueOnce(jsonResponse(completedOperation('Первое')))
        .mockResolvedValueOnce(jsonResponse({ id: 'operation-2', done: false }))
        .mockResolvedValueOnce(
          jsonResponse({ ...completedOperation('Второе'), id: 'operation-2' }),
        ),
    );

    await expect(runLongRecognition()).resolves.toBe('Первое');
    await expect(runLongRecognition()).resolves.toBe('Второе');

    const firstKey = mocks.putObject.mock.calls[0]?.[0];
    const secondKey = mocks.putObject.mock.calls[1]?.[0];
    expect(firstKey).toMatch(/^bot-voic\/phoronis\/[0-9a-f-]{36}$/);
    expect(secondKey).not.toBe(firstKey);
    expect(mocks.deleteObject.mock.calls).toEqual([[firstKey], [secondKey]]);
  });

  it('deletes the object after a provider error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: true })),
    );

    await expect(runLongRecognition()).resolves.toBeNull();

    expect(mocks.deleteObject).toHaveBeenCalledWith(
      mocks.putObject.mock.calls[0]?.[0],
    );
  });

  it('deletes the object after polling times out', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ id: 'operation-1', done: false })),
    );

    await expect(runLongRecognition()).resolves.toBeNull();

    expect(mocks.deleteObject).toHaveBeenCalledWith(
      mocks.putObject.mock.calls[0]?.[0],
    );
  });

  it('deletes the object after abort', async () => {
    const controller = new AbortController();
    mocks.signal = controller.signal;
    mocks.putObject.mockImplementationOnce(async () => {
      controller.abort(new Error('aborted'));
      return new Response();
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const recognition = speechkit.recognize({
      file: Buffer.from('voice'),
      duration: 30,
    });
    const rejection = expect(recognition).rejects.toThrow('aborted');
    await vi.runAllTimersAsync();
    await rejection;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.deleteObject).toHaveBeenCalledWith(
      mocks.putObject.mock.calls[0]?.[0],
    );
  });

  it('logs cleanup failure without replacing a successful result', async () => {
    mocks.deleteObject.mockRejectedValueOnce(new Error('delete failed'));
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ id: 'operation-1', done: false }))
        .mockResolvedValueOnce(jsonResponse(completedOperation())),
    );

    await expect(runLongRecognition()).resolves.toBe('Распознано');

    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'speech.s3_cleanup_failed' }),
      'Failed to delete speech recognition object',
    );
  });

  it('does not opt short recognition into provider data logging', async () => {
    let request: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        request = init;
        return jsonResponse({ result: 'Коротко' });
      }),
    );

    await expect(
      speechkit.recognize({ file: Buffer.from('voice'), duration: 1 }),
    ).resolves.toBe('Коротко');

    expect(request?.headers).not.toHaveProperty('x-data-logging-enabled');
  });
});
