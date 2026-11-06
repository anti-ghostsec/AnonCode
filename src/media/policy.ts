import { inspectImage, type ImageInfo } from "./inspect.ts";

/**
 * Provider image limits and the policy that keeps AnonCode from ever sending a
 * model an image it will refuse.
 *
 * Background: several vision models reject images whose shortest edge is below
 * a provider minimum ("image too small"). When an agent naively re-sends the
 * same payload after that error, it loops forever. AnonCode eliminates the
 * loop by deciding, up front, what to do with every image:
 *
 *   ok        -> within limits, send as-is
 *   upscale   -> below the minimum edge; enlarge to satisfy it
 *   downscale -> above the maximum edge / pixel budget; shrink to fit
 *   reject    -> cannot be inspected or cannot be made valid
 *
 * When a resizer is available the image is normalized; when it is not (or on
 * `reject`), the caller substitutes a descriptive TEXT placeholder so the
 * model receives something valid and the conversation proceeds. Either way the
 * invalid image never reaches the provider, so the refuse/retry loop cannot
 * start.
 */

export type ProviderImageLimits = {
  /** Shortest edge a model will accept, in pixels. */
  minEdge: number;
  /** Longest edge before the provider down-samples or errors. */
  maxEdge: number;
  /** Total pixel budget (width * height). */
  maxPixels: number;
  /** Max encoded size in bytes. */
  maxBytes: number;
};

// Conservative defaults that satisfy the common vision providers. The 200x60
// fixture that breaks opencode fails `minEdge` here (60 < 200) and is routed
// to `upscale` instead of being sent and refused.
export const DEFAULT_IMAGE_LIMITS: ProviderImageLimits = {
  minEdge: 200,
  maxEdge: 1568,
  maxPixels: 1568 * 1568,
  maxBytes: 5 * 1024 * 1024,
};

export type ImageAction = "ok" | "upscale" | "downscale" | "reject";

export type ImagePlan = {
  action: ImageAction;
  reason: string;
  info: ImageInfo | null;
  /** Target dimensions for upscale/downscale (absent for ok/reject). */
  target?: { width: number; height: number };
};

export function planImage(
  buf: Buffer,
  limits: ProviderImageLimits = DEFAULT_IMAGE_LIMITS,
): ImagePlan {
  const info = inspectImage(buf);
  if (!info) {
    return { action: "reject", reason: "unrecognized or unreadable image header", info: null };
  }
  const { width, height } = info;
  if (width <= 0 || height <= 0) {
    return { action: "reject", reason: `invalid dimensions ${width}x${height}`, info };
  }

  if (buf.byteLength > limits.maxBytes) {
    const target = fitWithin(width, height, limits.maxEdge, limits.maxPixels);
    return {
      action: "downscale",
      reason: `encoded size ${buf.byteLength}B exceeds ${limits.maxBytes}B`,
      info,
      target,
    };
  }

  const shortEdge = Math.min(width, height);
  const longEdge = Math.max(width, height);

  if (shortEdge < limits.minEdge) {
    const target = scaleUpToMinEdge(width, height, limits);
    return {
      action: "upscale",
      reason: `short edge ${shortEdge}px below provider minimum ${limits.minEdge}px`,
      info,
      target,
    };
  }

  if (longEdge > limits.maxEdge || width * height > limits.maxPixels) {
    const target = fitWithin(width, height, limits.maxEdge, limits.maxPixels);
    return {
      action: "downscale",
      reason: `long edge ${longEdge}px / ${width * height}px exceeds limits`,
      info,
      target,
    };
  }

  return { action: "ok", reason: "within provider limits", info };
}

/** Enlarge so the short edge reaches minEdge, preserving aspect, without blowing maxEdge. */
function scaleUpToMinEdge(
  width: number,
  height: number,
  limits: ProviderImageLimits,
): { width: number; height: number } {
  const shortEdge = Math.min(width, height);
  let factor = limits.minEdge / shortEdge;
  let w = Math.round(width * factor);
  let h = Math.round(height * factor);
  // Don't let the long edge exceed the max while satisfying the min.
  if (Math.max(w, h) > limits.maxEdge) {
    factor = limits.maxEdge / Math.max(width, height);
    w = Math.max(limits.minEdge, Math.round(width * factor));
    h = Math.max(limits.minEdge, Math.round(height * factor));
  }
  return { width: w, height: h };
}

/** Shrink to fit both the max edge and the pixel budget, preserving aspect. */
function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
  maxPixels: number,
): { width: number; height: number } {
  let factor = Math.min(1, maxEdge / Math.max(width, height));
  if (width * height * factor * factor > maxPixels) {
    factor = Math.min(factor, Math.sqrt(maxPixels / (width * height)));
  }
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

/**
 * Human-readable placeholder used when an image cannot be normalized (no
 * resizer wired, or `reject`). Sent in place of the image so the model still
 * gets valid, useful context instead of an input it will refuse.
 */
export function imagePlaceholder(plan: ImagePlan, filename?: string): string {
  const name = filename ? ` "${filename}"` : "";
  const dims = plan.info ? `${plan.info.width}x${plan.info.height} ${plan.info.format}` : "unknown format";
  return `[image${name} omitted — ${dims}; ${plan.reason}. ` +
    `It was not sent to the model to avoid an unprocessable-image error.]`;
}
