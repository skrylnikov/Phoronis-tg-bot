import { describe, expect, it, vi } from 'vitest';

vi.mock('../health-readiness', () => ({
  getReadinessResponse: vi.fn(async () => Response.json({ status: 'ok' })),
}));

vi.mock('../logger', () => ({
  logger: { error: vi.fn() },
}));

import { createHealthFetch } from '../health-routing';

describe('health and webhook server routing', () => {
  it('keeps health probes and routes webhook POSTs', async () => {
    const webhookHandler = vi.fn(async () => Response.json({ ok: true }));
    const fetch = createHealthFetch({
      webhookHandler,
      webhookPath: '/telegram/webhook',
    });

    const healthResponse = await fetch(new Request('http://localhost/healthz'));
    const webhookResponse = await fetch(
      new Request('http://localhost/telegram/webhook', { method: 'POST' }),
    );

    expect(healthResponse.status).toBe(200);
    expect(webhookResponse.status).toBe(200);
    expect(webhookHandler).toHaveBeenCalledOnce();
  });

  it('does not expose webhook processing through GET', async () => {
    const webhookHandler = vi.fn(async () => Response.json({ ok: true }));
    const fetch = createHealthFetch({
      webhookHandler,
      webhookPath: '/telegram/webhook',
    });

    const response = await fetch(
      new Request('http://localhost/telegram/webhook'),
    );

    expect(response.status).toBe(405);
    expect(webhookHandler).not.toHaveBeenCalled();
  });
});
