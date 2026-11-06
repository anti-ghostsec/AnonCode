import { createHash } from "node:crypto";
import {
  type Provider,
  type GenerateRequest,
  type GenerateResult,
  ProviderError,
} from "../providers/types.ts";
import { preflightMessages, stripImages } from "../providers/prepare.ts";
import { DEFAULT_IMAGE_LIMITS, type ProviderImageLimits } from "../media/policy.ts";
import {
  LoopGuard,
  DEFAULT_LOOP_GUARD,
  errorSignature,
  type LoopGuardOptions,
} from "./loopguard.ts";

/**
 * Generate one assistant reply, robustly.
 *
 * Pipeline:
 *   1. Preflight every image against provider limits (too-small/too-large/
 *      unreadable images become placeholders) — so a well-behaved model never
 *      refuses an image and the loop never starts.
 *   2. Call the provider inside a LoopGuard.
 *   3. On a provider error:
 *        - image_*  -> strip remaining images and retry ONCE more;
 *        - auth / bad_request -> fatal, rethrow immediately;
 *        - rate_limit / network -> brief backoff then retry.
 *      Every error is recorded with a stable signature, so if the same failure
 *      recurs (including "there are no more images to strip") the guard trips
 *      and we stop with a clear error instead of looping forever.
 */
export async function generateReply(
  provider: Provider,
  req: GenerateRequest,
  opts: {
    limits?: ProviderImageLimits;
    guard?: LoopGuardOptions;
    onNote?: (note: string) => void;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<GenerateResult> {
  const limits = opts.limits ?? DEFAULT_IMAGE_LIMITS;
  const guard = new LoopGuard(opts.guard ?? DEFAULT_LOOP_GUARD);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const pre = preflightMessages(req.messages, limits);
  for (const n of pre.notes) opts.onNote?.(n);
  let messages = pre.messages;

  for (;;) {
    guard.beginStep();
    try {
      const result = await provider.generate({ ...req, messages });
      guard.recordProgress(`ok:${hash(result.text)}`);
      return result;
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;

      if (err.kind === "auth" || err.kind === "bad_request") {
        throw err; // no payload change can fix these
      }

      if (err.kind === "image_too_small" || err.kind === "image_invalid") {
        const stripped = stripImages(messages);
        messages = stripped.messages;
        if (stripped.changed) {
          opts.onNote?.(`provider rejected an image (${err.kind}); removed it and retrying`);
        }
        // If nothing changed, the signature below stays constant and the guard
        // will trip rather than retry the identical request forever.
      } else if (err.kind === "rate_limit" || err.kind === "network") {
        await sleep(250);
      }

      const sig = errorSignature({
        provider: provider.name,
        kind: err.kind,
        contentHash: hash(JSON.stringify(messages)),
      });
      guard.recordError(sig, err.message); // throws AgentLoopError after N repeats
    }
  }
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}
