import { runShell } from "../tools/bash.ts";

/**
 * Deterministic verifier gate. After a worker turn, AnonCode can run a
 * project-defined check command (tests, a build, a linter) against the live
 * runspace. On failure the server loops the failure back to the worker — a
 * non-LLM quality gate that complements the reviewer loop: the reviewer judges
 * intent, the verifier proves the code actually runs.
 */
export type VerifyResult = { ok: boolean; output: string };

export async function runVerifier(command: string, cwd: string, timeoutMs = 180000): Promise<VerifyResult> {
  const { code, out } = await runShell(command, cwd, Math.min(timeoutMs, 600000));
  const status = code === 124 ? "timed out" : `exit ${code}`;
  return { ok: code === 0, output: `[${status}]\n${out}`.trim() };
}

/** Build the feedback message that asks the worker to fix a failed check. */
export function verifierFeedback(command: string, output: string, maxChars = 4000): string {
  const trimmed = output.length > maxChars ? output.slice(0, maxChars) + `\n… [truncated ${output.length - maxChars} chars]` : output;
  return `The automated checks (\`${command}\`) failed. Fix the problems so the command passes, then stop.\n\n[check output]\n${trimmed}`;
}
