import { createControlledPromise, sleep } from '@antfu/utils';
import type { TokenUsage } from '@moonshot-ai/kosong';

import type { PromptOrigin } from '../agent/context';
import { abortable, createDeadlineAbortSignal } from '../utils/abort';

const SUBAGENT_LAUNCH_BATCH_SIZE = 10;
const SUBAGENT_QUEUE_LAUNCH_DELAY_MS = 500;

export type QueuedSubagentTask<T = unknown> = {
  readonly data: T;
  readonly profileName: string;
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  readonly runInBackground: boolean;
  readonly origin?: PromptOrigin;
};

export type QueuedSubagentRunOptions = {
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly totalTimeoutMs?: number;
};

export type QueuedSubagentRunResult<T = unknown> = {
  readonly task: QueuedSubagentTask<T>;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed';
  readonly result?: string;
  readonly usage?: TokenUsage;
  readonly error?: string;
};

export type QueuedSubagentAttemptOutcome<T> = 'rate_limited' | QueuedSubagentRunResult<T>;

type QueuedSubagentAttempt<T> = {
  readonly index: number;
  readonly outcome: Promise<QueuedSubagentAttemptOutcome<T>>;
  readonly readiness: Promise<void>;
  readonly ready: boolean;
  settled: boolean;
};

export type QueuedSubagentAttemptOptions = QueuedSubagentRunOptions & {
  readonly totalTimedOut: () => boolean;
  readonly markReady: () => void;
};

type RunQueuedSubagentAttempt = <T>(
  task: QueuedSubagentTask<T>,
  options: QueuedSubagentAttemptOptions,
) => Promise<QueuedSubagentAttemptOutcome<T>>;

export class SubagentLaunchQueue {
  constructor(private readonly runAttempt: RunQueuedSubagentAttempt) {}

  async run<T>(
    tasks: readonly QueuedSubagentTask<T>[],
    runOptions: QueuedSubagentRunOptions,
  ): Promise<Array<QueuedSubagentRunResult<T>>> {
    const totalDeadline =
      runOptions.totalTimeoutMs === undefined
        ? undefined
        : createDeadlineAbortSignal(runOptions.signal, runOptions.totalTimeoutMs);
    const options: QueuedSubagentRunOptions = {
      signal: totalDeadline?.signal ?? runOptions.signal,
      timeoutMs: runOptions.timeoutMs,
      totalTimeoutMs: runOptions.totalTimeoutMs,
    };
    const totalTimedOut = (): boolean => totalDeadline?.timedOut() === true;

    const queued = tasks.map((_, index) => index);
    const active: Array<QueuedSubagentAttempt<T>> = [];
    const results: Array<QueuedSubagentRunResult<T> | undefined> = Array.from({
      length: tasks.length,
    });
    let launchedAttempts = 0;
    let slotLimit: number | undefined;
    const hasResults = (): boolean => results.some((result) => result !== undefined);

    const finish = (fallback: string): Array<QueuedSubagentRunResult<T>> =>
      results.map(
        (result, index) => result ?? { task: tasks[index]!, status: 'failed', error: fallback },
      );

    const enqueue = (index: number): void => {
      if (results[index] !== undefined) return;
      queued.push(index);
      queued.sort((a, b) => a - b);
    };

    const failQueued = (error: string): void => {
      for (const index of queued.splice(0)) {
        results[index] = { task: tasks[index]!, status: 'failed', error };
      }
    };

    const launch = (index: number): QueuedSubagentAttempt<T> => {
      const readiness = createControlledPromise<void>();
      let ready = false;
      const markReady = (): void => {
        if (ready) return;
        ready = true;
        readiness.resolve();
      };
      const outcome = this.runAttempt(tasks[index]!, { ...options, totalTimedOut, markReady });
      const attempt: QueuedSubagentAttempt<T> = {
        index,
        outcome,
        readiness,
        get ready() {
          return ready;
        },
        settled: false,
      };
      launchedAttempts += 1;
      void outcome.then(
        () => {
          attempt.settled = true;
          markReady();
        },
        () => {
          attempt.settled = true;
          markReady();
        },
      );
      active.push(attempt);
      return attempt;
    };

    const processAttempt = async (attempt: QueuedSubagentAttempt<T>): Promise<boolean> => {
      active.splice(active.indexOf(attempt), 1);
      const outcome = await attempt.outcome;
      if (outcome === 'rate_limited') {
        slotLimit ??= Math.max(0, launchedAttempts - 2);
        enqueue(attempt.index);
        return false;
      }
      results[attempt.index] = outcome;
      return true;
    };

    const processSettledAttempts = async (): Promise<boolean> => {
      for (let attempt = active.find((item) => item.settled); attempt !== undefined; ) {
        if (!(await processAttempt(attempt))) return false;
        attempt = active.find((item) => item.settled);
      }
      return true;
    };

    const nextSettled = (): Promise<void> =>
      Promise.race(active.map((attempt) => attempt.outcome.then(() => undefined)));

    const nextSettledAttempt = async (): Promise<QueuedSubagentAttempt<T>> => {
      await nextSettled();
      return active.find((attempt) => attempt.settled)!;
    };

    const waitForRampBatch = async (
      batch: readonly QueuedSubagentAttempt<T>[],
    ): Promise<boolean> => {
      const batchReady = Promise.all(batch.map((attempt) => attempt.readiness));
      while (batch.some((attempt) => !attempt.ready)) {
        options.signal.throwIfAborted();
        await abortable(Promise.race([batchReady, nextSettled()]), options.signal);
        if (!(await processSettledAttempts())) return false;
      }
      return processSettledAttempts();
    };

    const launchQueuedUpToSlotLimit = async (): Promise<void> => {
      if (slotLimit === undefined || (active.length === 0 && !hasResults())) return;
      while (queued.length > 0 && active.length < slotLimit) {
        await abortable(sleep(SUBAGENT_QUEUE_LAUNCH_DELAY_MS), options.signal);
        if (active.length < slotLimit) launch(queued.shift()!);
      }
    };

    const launchRampBatch = (): Array<QueuedSubagentAttempt<T>> =>
      queued.splice(0, SUBAGENT_LAUNCH_BATCH_SIZE).map(launch);

    try {
      while (queued.length > 0) {
        if (slotLimit !== undefined) break;
        const batch = launchRampBatch();
        if (queued.length === 0) break;
        if (!(await waitForRampBatch(batch))) break;
      }

      if (active.length > 0 || hasResults()) await launchQueuedUpToSlotLimit();

      while (active.length > 0 || queued.length > 0) {
        options.signal.throwIfAborted();
        if (active.length === 0) {
          if (queued.length === 0) break;
          if (!hasResults()) {
            throw new Error(
              'Could not start any subagents because every launch attempt was rate limited.',
            );
          }
          failQueued('No running subagents remained to open queue slots after rate-limited launches.');
          break;
        }

        const settled = active.find((attempt) => attempt.settled);
        const attempt =
          settled ?? (await abortable(nextSettledAttempt(), options.signal));
        await processAttempt(attempt);
        await launchQueuedUpToSlotLimit();
      }

      return finish('Subagent stopped before it could finish.');
    } catch (error) {
      if (!totalTimedOut()) throw error;
      return finish(totalTimeoutMessage(options.totalTimeoutMs));
    } finally {
      totalDeadline?.clear();
    }
  }
}

export function totalTimeoutMessage(timeoutMs: number | undefined): string {
  return timeoutMs === undefined
    ? 'Subagent batch total timeout elapsed.'
    : `Subagent batch total timeout after ${formatTimeoutMs(timeoutMs)}.`;
}

export function formatTimeoutMs(timeoutMs: number): string {
  return `${String(timeoutMs / 1000)}s`;
}
