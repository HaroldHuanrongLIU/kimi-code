import type { TokenUsage } from '@moonshot-ai/kosong';

import type { PromptOrigin } from '../agent/context';
import { isAbortError } from '../loop/errors';
import {
  abortError,
  createDeadlineAbortSignal,
  isUserCancellation,
} from '../utils/abort';

const SUBAGENT_LAUNCH_BATCH_SIZE = 10;
const SUBAGENT_MAX_INITIAL_LAUNCHES = 30;
const SUBAGENT_QUEUE_LAUNCH_DELAY_MS = 500;
const SUBAGENT_RAMP_BATCH_DELAY_MS = 500;
const RATE_LIMIT_429_MESSAGE =
  "429 We're receiving too many requests at the moment. Please wait a moment and try again.";
const RATE_LIMIT_429_BODY =
  "We're receiving too many requests at the moment. Please wait a moment and try again.";

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
  readonly profileName: string;
  readonly status: 'completed' | 'failed';
  readonly result?: string;
  readonly usage?: TokenUsage;
  readonly error?: string;
};

export type QueuedSubagentAttemptOutcome<T> =
  | {
      readonly kind: 'rate_limited';
      readonly task: QueuedSubagentTask<T>;
    }
  | {
      readonly kind: 'result';
      readonly result: QueuedSubagentRunResult<T>;
    };

type QueuedSubagentAttempt<T> = {
  readonly task: QueuedSubagentTask<T>;
  readonly promise: Promise<QueuedSubagentAttemptOutcome<T>>;
  settled: boolean;
};

export type PreparedQueuedSubagentTask<T = unknown> = {
  readonly task: QueuedSubagentTask<T>;
  readonly agentId: string;
  readonly profileName: string;
  readonly start: (
    options: QueuedSubagentRunOptions,
    totalTimedOut: () => boolean,
  ) => Promise<QueuedSubagentAttemptOutcome<T>>;
  readonly cancel: (reason: unknown) => void;
};

export type QueuedSubagentRunHandle<T = unknown> = {
  readonly task: QueuedSubagentTask<T>;
  readonly agentId: string;
  readonly profileName: string;
  readonly completion: Promise<QueuedSubagentRunResult<T>>;
};

type SubagentLaunchQueueHost = {
  readonly prepareQueuedTask: <T>(
    task: QueuedSubagentTask<T>,
    options: QueuedSubagentRunOptions,
  ) => Promise<PreparedQueuedSubagentTask<T>>;
};

export class SubagentLaunchQueue {
  constructor(private readonly host: SubagentLaunchQueueHost) {}

  async run<T>(
    tasks: readonly QueuedSubagentTask<T>[],
    options: QueuedSubagentRunOptions,
  ): Promise<Array<QueuedSubagentRunResult<T>>> {
    const prepared = await Promise.all(
      tasks.map((task) => this.host.prepareQueuedTask(task, options)),
    );
    return await this.runPreparedBatch(prepared, options);
  }

  runPrepared<T>(
    prepared: PreparedQueuedSubagentTask<T>,
    options: QueuedSubagentRunOptions,
  ): QueuedSubagentRunHandle<T> {
    return {
      task: prepared.task,
      agentId: prepared.agentId,
      profileName: prepared.profileName,
      completion: this.runPreparedBatch([prepared], options).then((results) => {
        const result = results[0];
        if (result === undefined) {
          throw new Error('Queued subagent finished without a result.');
        }
        return result;
      }),
    };
  }

  private async runPreparedBatch<T>(
    prepared: readonly PreparedQueuedSubagentTask<T>[],
    options: QueuedSubagentRunOptions,
  ): Promise<Array<QueuedSubagentRunResult<T>>> {
    let totalDeadline: ReturnType<typeof createDeadlineAbortSignal> | undefined;
    try {
      totalDeadline =
        options.totalTimeoutMs === undefined
          ? undefined
          : createDeadlineAbortSignal(options.signal, options.totalTimeoutMs);
      return await this.runWithSignal(
        prepared,
        {
          signal: totalDeadline?.signal ?? options.signal,
          timeoutMs: options.timeoutMs,
          totalTimeoutMs: options.totalTimeoutMs,
        },
        () => totalDeadline?.timedOut() === true,
      );
    } finally {
      totalDeadline?.clear();
    }
  }

  private async runWithSignal<T>(
    prepared: readonly PreparedQueuedSubagentTask<T>[],
    options: QueuedSubagentRunOptions,
    totalTimedOut: () => boolean,
  ): Promise<Array<QueuedSubagentRunResult<T>>> {
    const tasks = prepared.map((task) => task.task);
    const pending = [...tasks];
    const queued: Array<QueuedSubagentTask<T>> = [];
    const queuedTasks = new Set<QueuedSubagentTask<T>>();
    const active: Array<QueuedSubagentAttempt<T>> = [];
    const results: Array<QueuedSubagentRunResult<T> | undefined> = Array.from({
      length: tasks.length,
    });
    const preparedTasks = new Map<QueuedSubagentTask<T>, PreparedQueuedSubagentTask<T>>();
    const taskIndexes = new Map(tasks.map((task, index) => [task, index]));
    let completedResults = 0;
    let launchedDuringRamp = 0;
    let rateLimitSeen = false;

    const resultIndex = (task: QueuedSubagentTask<T>): number => {
      const index = taskIndexes.get(task);
      if (index === undefined) {
        throw new Error('Queued subagent task was not registered');
      }
      return index;
    };

    const enqueue = (task: QueuedSubagentTask<T>): void => {
      if (results[resultIndex(task)] !== undefined || queuedTasks.has(task)) return;
      queuedTasks.add(task);
      queued.push(task);
      queued.sort((left, right) => resultIndex(left) - resultIndex(right));
    };

    const dequeue = (): QueuedSubagentTask<T> | undefined => {
      const task = queued.shift();
      if (task !== undefined) queuedTasks.delete(task);
      return task;
    };

    const launch = async (task: QueuedSubagentTask<T>): Promise<void> => {
      const prepared =
        preparedTasks.get(task) ?? (await this.host.prepareQueuedTask(task, options));
      preparedTasks.delete(task);
      const attempt: QueuedSubagentAttempt<T> = {
        task,
        settled: false,
        promise: prepared.start(options, totalTimedOut),
      };
      void attempt.promise.then(
        () => {
          attempt.settled = true;
        },
        () => {
          attempt.settled = true;
        },
      );
      active.push(attempt);
    };

    const processAttempt = async (attempt: QueuedSubagentAttempt<T>): Promise<boolean> => {
      const activeIndex = active.indexOf(attempt);
      if (activeIndex !== -1) active.splice(activeIndex, 1);
      const outcome = await attempt.promise;
      if (outcome.kind === 'rate_limited') {
        rateLimitSeen = true;
        enqueue(outcome.task);
        return false;
      }
      results[resultIndex(outcome.result.task)] = outcome.result;
      completedResults += 1;
      return true;
    };

    const processSettledAttempts = async (): Promise<void> => {
      while (true) {
        const settled = active.find((attempt) => attempt.settled);
        if (settled === undefined) return;
        await processAttempt(settled);
      }
    };

    try {
      for (const task of prepared) {
        preparedTasks.set(task.task, task);
      }

      while (
        pending.length > 0 &&
        launchedDuringRamp < SUBAGENT_MAX_INITIAL_LAUNCHES &&
        !rateLimitSeen
      ) {
        const batchSize = Math.min(
          SUBAGENT_LAUNCH_BATCH_SIZE,
          pending.length,
          SUBAGENT_MAX_INITIAL_LAUNCHES - launchedDuringRamp,
        );
        for (let i = 0; i < batchSize; i += 1) {
          const task = pending.shift();
          if (task === undefined) break;
          await launch(task);
          launchedDuringRamp += 1;
        }
        if (pending.length === 0 || launchedDuringRamp >= SUBAGENT_MAX_INITIAL_LAUNCHES) break;
        await waitForRateLimitOrDelay(active, options.signal);
        await processSettledAttempts();
      }

      for (const task of pending) {
        enqueue(task);
      }
      pending.length = 0;

      while (completedResults < tasks.length) {
        options.signal.throwIfAborted();
        if (active.length === 0) {
          if (queued.length === 0) break;
          if (completedResults === 0) {
            throw new Error(
              'Could not start any subagents because every launch attempt was rate limited.',
            );
          }
          while (queued.length > 0) {
            const task = dequeue();
            if (task === undefined) break;
            results[resultIndex(task)] = failedQueuedResult(
              task,
              'No running subagents remained to open queue slots after rate-limited launches.',
            );
            completedResults += 1;
          }
          break;
        }

        const attempt = await nextSettledAttempt(active, options.signal);
        const openedSlot = await processAttempt(attempt);
        if (!openedSlot || queued.length === 0) continue;
        await sleepWithSignal(SUBAGENT_QUEUE_LAUNCH_DELAY_MS, options.signal);
        const task = dequeue();
        if (task !== undefined) await launch(task);
      }
    } catch (error) {
      if (!totalTimedOut()) throw error;
      const message = totalTimeoutMessage(options.totalTimeoutMs);
      for (const task of tasks) {
        const index = resultIndex(task);
        if (results[index] !== undefined) continue;
        results[index] = failedQueuedResult(task, message);
      }
    } finally {
      cancelPreparedTasks(preparedTasks);
    }

    return results.map((result, index) => {
      if (result !== undefined) return result;
      return failedQueuedResult(tasks[index]!, 'Subagent stopped before it could finish.');
    });
  }
}

function failedQueuedResult<T>(
  task: QueuedSubagentTask<T>,
  error: string,
): QueuedSubagentRunResult<T> {
  return {
    task,
    profileName: task.profileName,
    status: 'failed',
    error,
  };
}

function cancelPreparedTasks<T>(
  preparedTasks: Map<QueuedSubagentTask<T>, PreparedQueuedSubagentTask<T>>,
): void {
  const reason = new Error('Subagent queue stopped before the prompt was launched.');
  for (const task of preparedTasks.values()) {
    task.cancel(reason);
  }
  preparedTasks.clear();
}

async function waitForRateLimitOrDelay<T>(
  active: ReadonlyArray<QueuedSubagentAttempt<T>>,
  signal: AbortSignal,
): Promise<void> {
  if (active.length === 0) {
    await sleepWithSignal(SUBAGENT_RAMP_BATCH_DELAY_MS, signal);
    return;
  }
  const rateLimited = Promise.race(
    active.map((attempt) =>
      attempt.promise.then((outcome) => {
        if (outcome.kind === 'rate_limited') return;
        return new Promise<never>(() => {});
      }),
    ),
  );
  await Promise.race([sleepWithSignal(SUBAGENT_RAMP_BATCH_DELAY_MS, signal), rateLimited]);
}

async function nextSettledAttempt<T>(
  active: ReadonlyArray<QueuedSubagentAttempt<T>>,
  signal: AbortSignal,
): Promise<QueuedSubagentAttempt<T>> {
  const settled = active.find((attempt) => attempt.settled);
  if (settled !== undefined) return settled;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    for (const attempt of active) {
      void attempt.promise.then(
        () => {
          cleanup();
          resolve(attempt);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    }
  });
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timeout = undefined;
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = undefined;
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function totalTimeoutMessage(timeoutMs: number | undefined): string {
  return timeoutMs === undefined
    ? 'Subagent batch total timeout elapsed.'
    : `Subagent batch total timeout after ${formatTimeoutMs(timeoutMs)}.`;
}

export function formatTimeoutMs(timeoutMs: number): string {
  return `${String(timeoutMs / 1000)}s`;
}

export function formatQueuedSubagentError(
  error: unknown,
  signal: AbortSignal,
  timeouts: {
    readonly subagentTimedOut: () => boolean;
    readonly subagentTimeoutMs?: number;
    readonly totalTimedOut: () => boolean;
    readonly totalTimeoutMs?: number;
  },
): string {
  if (timeouts.subagentTimedOut() && timeouts.subagentTimeoutMs !== undefined) {
    return `Subagent timed out after ${formatTimeoutMs(timeouts.subagentTimeoutMs)}.`;
  }
  if (timeouts.totalTimedOut() && timeouts.totalTimeoutMs !== undefined) {
    return totalTimeoutMessage(timeouts.totalTimeoutMs);
  }
  if (isUserCancellation(signal.reason)) {
    return 'The user manually interrupted this subagent batch.';
  }
  if (isAbortError(error)) {
    return 'The subagent was stopped before it finished.';
  }
  return errorMessage(error);
}

export function isRateLimit429Error(error: unknown): boolean {
  const message = errorMessage(error);
  if (message.includes(RATE_LIMIT_429_MESSAGE)) return true;
  if (!message.includes(RATE_LIMIT_429_BODY)) return false;
  if (message.includes('429')) return true;
  if (message.includes('provider.rate_limit')) return true;
  return maybeStatusCode(error) === 429;
}

function maybeStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') return statusCode;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
