import { planImage, imagePlaceholder, type ProviderImageLimits } from "../media/policy.ts";
import { DEFAULT_IMAGE_LIMITS } from "../media/policy.ts";
import type { ProviderMessage, ProviderContent } from "./types.ts";

/**
 * Image preflight. Runs before every provider call: any image that a model
 * would refuse (too small, too large, unreadable) is either kept as-is (when
 * within limits) or replaced with a descriptive text placeholder. No resizer
 * is wired yet, so the current policy is "send valid images, describe the
 * rest" — which is enough to guarantee the model never errors on an image and
 * therefore the refuse/retry loop can never begin.
 *
 * When pixel resizing lands (roadmap Phase 6), the upscale/downscale branches
 * will reshape instead of describing.
 */

export type PreflightResult = {
  messages: ProviderMessage[];
  notes: string[];
};

export function preflightMessages(
  messages: ProviderMessage[],
  limits: ProviderImageLimits = DEFAULT_IMAGE_LIMITS,
): PreflightResult {
  const notes: string[] = [];
  const out = messages.map((m) => ({
    role: m.role,
    content: m.content.map((c) => sanitize(c, limits, notes)),
  }));
  return { messages: out, notes };
}

function sanitize(
  content: ProviderContent,
  limits: ProviderImageLimits,
  notes: string[],
): ProviderContent {
  if (content.type !== "image") return content;
  let buf: Buffer;
  try {
    buf = Buffer.from(content.dataB64, "base64");
  } catch {
    const text = "[image omitted — could not decode base64 data]";
    notes.push(text);
    return { type: "text", text };
  }
  const plan = planImage(buf, limits);
  if (plan.action === "ok") return content;
  const text = imagePlaceholder(plan, content.filename);
  notes.push(text);
  return { type: "text", text };
}

/** Strip every image to a placeholder — the remediation used by the agent loop
 * if a provider still refuses an image the preflight considered acceptable. */
export function stripImages(messages: ProviderMessage[]): {
  messages: ProviderMessage[];
  changed: boolean;
} {
  let changed = false;
  const out = messages.map((m) => ({
    role: m.role,
    content: m.content.map((c) => {
      if (c.type !== "image") return c;
      changed = true;
      return {
        type: "text" as const,
        text: `[image${c.filename ? ` "${c.filename}"` : ""} removed after the model rejected it]`,
      };
    }),
  }));
  return { messages: out, changed };
}
