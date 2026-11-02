import type { Api } from 'grammy';

export interface TelegramHealth {
  available: boolean;
  checkedAt: string;
  latencyMs: number;
}

/** getMe checks the bot's configured API connection without sending messages. */
export function createTelegramHealthCheck(
  api: Pick<Api, 'getMe'>,
  { timeoutMs = 5_000, cacheMs = 15_000 } = {},
): () => Promise<TelegramHealth> {
  let cached: TelegramHealth | undefined;
  let expiresAt = 0;
  let pending: Promise<TelegramHealth> | undefined;

  async function check(): Promise<TelegramHealth> {
    const started = Date.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let available = false;
    try {
      await Promise.race([
        // grammY types use the AbortSignal polyfill; Node's signal works at runtime.
        api.getMe(controller.signal as unknown as Parameters<Api['getMe']>[0]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('Telegram health check timed out'));
            controller.abort();
          }, timeoutMs);
        }),
      ]);
      available = true;
    } catch {
      // Never expose raw API errors: they may contain the bot token or relay URL.
    } finally {
      clearTimeout(timer);
    }
    cached = { available, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started };
    expiresAt = Date.now() + cacheMs;
    return cached;
  }

  return () => {
    if (cached && Date.now() < expiresAt) return Promise.resolve(cached);
    // All open admin pages share one probe per server instance.
    if (!pending) pending = check().finally(() => { pending = undefined; });
    return pending;
  };
}
