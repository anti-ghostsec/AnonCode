import { type Provider, type GenerateRequest, type GenerateResult, ProviderError } from "./types.ts";

/**
 * In-memory provider for tests and offline runs. It can simulate the exact
 * failure this project exists to fix: refusing any request that contains an
 * image. Useful for proving the agent loop remediates (strips the image) or
 * trips the loop guard instead of hanging.
 */
export class MockProvider implements Provider {
  readonly name: string;
  private calls = 0;

  constructor(
    private readonly opts: {
      name?: string;
      /** Throw image_too_small whenever a request still contains an image. */
      refuseImages?: boolean;
      /** Always throw this error, regardless of content (models no payload fix helps). */
      alwaysFail?: ProviderError;
      reply?: (req: GenerateRequest) => string;
    } = {},
  ) {
    this.name = opts.name ?? "mock";
  }

  get callCount(): number {
    return this.calls;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls += 1;
    if (this.opts.alwaysFail) throw this.opts.alwaysFail;
    const hasImage = req.messages.some((m) => m.content.some((c) => c.type === "image"));
    if (this.opts.refuseImages && hasImage) {
      throw new ProviderError("image_too_small", "image dimensions below model minimum", false);
    }
    const text = this.opts.reply ? this.opts.reply(req) : `mock-reply(${lastText(req)})`;
    return { text, stopReason: "stop" };
  }
}

function lastText(req: GenerateRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    const t = m.content.find((c) => c.type === "text");
    if (t && t.type === "text") return t.text;
  }
  return "";
}
