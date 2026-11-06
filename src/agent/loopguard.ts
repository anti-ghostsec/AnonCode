/**
 * Loop guard for the agent's step loop.
 *
 * Two independent failure modes can make a coding agent run forever:
 *   1. A hard error that recurs on every retry (e.g. a provider refusing an
 *      image as "too small" — the exact opencode bug this project fixes).
 *   2. A soft livelock: the agent keeps producing the same action/output with
 *      no progress (e.g. re-reading the same file, re-issuing the same tool
 *      call) and never terminates.
 *
 * The guard caps total iterations and, crucially, trips as soon as the SAME
 * failure or the SAME no-progress signature repeats too many times. It never
 * silently continues: it throws AgentLoopError so the caller surfaces a clear
 * terminal message instead of hanging.
 */

export type LoopGuardOptions = {
  /** Absolute ceiling on steps regardless of progress. */
  maxSteps: number;
  /** Trip after this many consecutive identical errors. */
  maxRepeatedErrors: number;
  /** Trip after this many consecutive identical no-progress signatures. */
  maxRepeatedStalls: number;
};

export const DEFAULT_LOOP_GUARD: LoopGuardOptions = {
  maxSteps: 100,
  maxRepeatedErrors: 3,
  maxRepeatedStalls: 4,
};

export type LoopStopReason =
  | "max-steps"
  | "repeated-error"
  | "repeated-stall";

export class AgentLoopError extends Error {
  constructor(
    readonly reason: LoopStopReason,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "AgentLoopError";
  }
}

export class LoopGuard {
  private steps = 0;
  private lastErrorSig: string | null = null;
  private repeatedErrors = 0;
  private lastProgressSig: string | null = null;
  private repeatedStalls = 0;

  constructor(private readonly opts: LoopGuardOptions = DEFAULT_LOOP_GUARD) {}

  get stepCount(): number {
    return this.steps;
  }

  /** Call once at the top of every loop iteration. Throws when the cap is hit. */
  beginStep(): void {
    this.steps += 1;
    if (this.steps > this.opts.maxSteps) {
      throw new AgentLoopError(
        "max-steps",
        `agent stopped after ${this.opts.maxSteps} steps without finishing`,
      );
    }
  }

  /**
   * Record a failed step. `signature` identifies the failure (e.g. provider
   * error code + offending content hash). Identical consecutive failures trip
   * the guard; a different failure resets the streak.
   */
  recordError(signature: string, detail?: string): void {
    if (signature === this.lastErrorSig) {
      this.repeatedErrors += 1;
    } else {
      this.lastErrorSig = signature;
      this.repeatedErrors = 1;
    }
    if (this.repeatedErrors >= this.opts.maxRepeatedErrors) {
      throw new AgentLoopError(
        "repeated-error",
        `the same error recurred ${this.repeatedErrors} times; stopping instead of retrying forever`,
        detail ?? signature,
      );
    }
  }

  /**
   * Record a successful step's progress signature (e.g. a hash of the action
   * taken + resulting state). Identical consecutive signatures mean the agent
   * is spinning in place; enough of them trip the guard. Any new signature
   * (real progress) resets the streak.
   */
  recordProgress(signature: string): void {
    this.lastErrorSig = null;
    this.repeatedErrors = 0;
    if (signature === this.lastProgressSig) {
      this.repeatedStalls += 1;
    } else {
      this.lastProgressSig = signature;
      this.repeatedStalls = 1;
      return;
    }
    if (this.repeatedStalls >= this.opts.maxRepeatedStalls) {
      throw new AgentLoopError(
        "repeated-stall",
        `agent repeated the same action ${this.repeatedStalls} times with no progress; stopping`,
        signature,
      );
    }
  }
}

/**
 * Stable signature for a provider failure, used as the error key above. Groups
 * retries of the "same" failure together so the guard can detect the loop.
 */
export function errorSignature(parts: {
  provider?: string;
  code?: string | number;
  kind?: string;
  contentHash?: string;
}): string {
  return [parts.provider ?? "", parts.kind ?? "", parts.code ?? "", parts.contentHash ?? ""].join("|");
}
