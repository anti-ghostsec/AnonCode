import { runShell } from "../tools/bash.ts";

/**
 * Deterministic verifier gate. After a worker turn, AnonCode can run a
 * project-defined check command (tests, a build, a linter) against the live
 * runspace. On failure the server loops the failure back to the worker — a
 * non-LLM quality gate that complements the reviewer loop: the reviewer judges
 * intent, the verifier proves the code actually runs.
 */
export type VerifyResult = {
  ok: boolean;
  output: string;
  /** The command itself couldn't run (not installed, bad path) — a config
   * problem with the check, not a failure of the project's code. */
  couldNotRun: boolean;
};

export async function runVerifier(command: string, cwd: string, timeoutMs = 180000): Promise<VerifyResult> {
  const { code, out } = await runShell(command, cwd, Math.min(timeoutMs, 600000));
  const status = code === 124 ? "timed out" : `exit ${code}`;
  // 127 == command not found; also catch the shell's own "not found" message.
  const couldNotRun = code === 127 || /: command not found|: No such file or directory/i.test(out);
  return { ok: code === 0, output: `[${status}]\n${out}`.trim(), couldNotRun };
}

/** Build the feedback that asks the worker to fix a failed check. It is careful
 * to forbid gaming the check itself (the real failure mode: a model that makes
 * the check "pass" by faking or deleting it rather than fixing the code). */
export function verifierFeedback(command: string, output: string, maxChars = 4000): string {
  const trimmed = output.length > maxChars ? output.slice(0, maxChars) + `\n… [truncated ${output.length - maxChars} chars]` : output;
  return (
    `The project's check command (\`${command}\`) failed. Fix the underlying code or tests so it passes legitimately.\n` +
    `Do NOT modify, delete, stub, or shadow the check command itself, and do not create files whose only purpose is to make it exit 0 — that is not a real fix. ` +
    `If the command looks wrong or can't apply to this task, say so instead of working around it.\n\n` +
    `[check output]\n${trimmed}`
  );
}
