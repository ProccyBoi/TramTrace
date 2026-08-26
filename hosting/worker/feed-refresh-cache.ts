export interface FeedRefreshBatch<Key extends string, Value> {
  updates: ReadonlyArray<readonly [Key, Value]>;
  errors: Partial<Record<Key, string>>;
}

export interface FeedRefreshSnapshot<Key extends string, Value> {
  parts: Value[];
  attemptedAt: number;
  nextAttemptAt: number;
  consecutiveAllFailures: number;
  errors: Partial<Record<Key, string>>;
}

export const MAX_ALL_FAILURE_BACKOFF_SECONDS = 300;

export function allFailureBackoffSeconds(
  cacheSeconds: number,
  consecutiveAllFailures: number,
  maximumSeconds = MAX_ALL_FAILURE_BACKOFF_SECONDS,
): number {
  const baseSeconds = Math.max(1, cacheSeconds);
  const exponent = Math.max(
    0,
    Math.min(30, consecutiveAllFailures - 1),
  );
  return Math.min(maximumSeconds, baseSeconds * 2 ** exponent);
}

export class FeedRefreshCache<Key extends string, Value> {
  private readonly parts = new Map<Key, Value>();
  private errors: Partial<Record<Key, string>> = {};
  private attemptedAt = 0;
  private nextAttemptAt = 0;
  private consecutiveAllFailures = 0;
  private refreshInFlight: Promise<FeedRefreshSnapshot<Key, Value>> | null =
    null;
  private generation = 0;

  reset(): void {
    this.parts.clear();
    this.errors = {};
    this.attemptedAt = 0;
    this.nextAttemptAt = 0;
    this.consecutiveAllFailures = 0;
    this.refreshInFlight = null;
    this.generation += 1;
  }

  peek(): FeedRefreshSnapshot<Key, Value> {
    return this.snapshot();
  }

  async getSnapshot(
    now: number,
    cacheSeconds: number,
    refresh: () => Promise<FeedRefreshBatch<Key, Value>>,
    clock: () => number = () => now,
  ): Promise<FeedRefreshSnapshot<Key, Value>> {
    if (now < this.nextAttemptAt) {
      return this.snapshotOrThrow();
    }

    if (!this.refreshInFlight) {
      const generation = this.generation;
      const promise = this.runRefresh(
        now,
        cacheSeconds,
        generation,
        refresh,
        clock,
      ).finally(() => {
        if (this.refreshInFlight === promise) {
          this.refreshInFlight = null;
        }
      });
      this.refreshInFlight = promise;
    }
    return this.refreshInFlight;
  }

  private async runRefresh(
    now: number,
    cacheSeconds: number,
    generation: number,
    refresh: () => Promise<FeedRefreshBatch<Key, Value>>,
    clock: () => number,
  ): Promise<FeedRefreshSnapshot<Key, Value>> {
    let batch: FeedRefreshBatch<Key, Value>;
    try {
      batch = await refresh();
    } catch (error) {
      if (generation !== this.generation) {
        throw new Error("feed cache reset during refresh");
      }
      this.recordAllFeedFailure(Math.max(now, clock()), cacheSeconds);
      if (this.parts.size > 0) {
        return this.snapshot();
      }
      throw error;
    }

    if (generation !== this.generation) {
      throw new Error("feed cache reset during refresh");
    }

    const completedAt = Math.max(now, clock());
    this.attemptedAt = completedAt;
    this.errors = { ...batch.errors };
    if (batch.updates.length === 0) {
      this.recordAllFeedFailure(completedAt, cacheSeconds);
    } else {
      for (const [key, value] of batch.updates) {
        this.parts.set(key, value);
      }
      this.consecutiveAllFailures = 0;
      this.nextAttemptAt = completedAt + Math.max(1, cacheSeconds);
    }
    return this.snapshotOrThrow();
  }

  private recordAllFeedFailure(
    now: number,
    cacheSeconds: number,
  ): void {
    this.attemptedAt = now;
    this.consecutiveAllFailures += 1;
    this.nextAttemptAt =
      now +
      allFailureBackoffSeconds(
        cacheSeconds,
        this.consecutiveAllFailures,
      );
  }

  private snapshot(): FeedRefreshSnapshot<Key, Value> {
    return {
      parts: Array.from(this.parts.values()),
      attemptedAt: this.attemptedAt,
      nextAttemptAt: this.nextAttemptAt,
      consecutiveAllFailures: this.consecutiveAllFailures,
      errors: { ...this.errors },
    };
  }

  private snapshotOrThrow(): FeedRefreshSnapshot<Key, Value> {
    if (this.parts.size === 0) {
      throw new Error("no realtime feed available");
    }
    return this.snapshot();
  }
}
