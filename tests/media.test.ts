import { test, expect } from "bun:test";
import { inspectImage } from "../src/media/inspect.ts";
import { planImage, imagePlaceholder, DEFAULT_IMAGE_LIMITS } from "../src/media/policy.ts";

function makePng(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function makeGif(w: number, h: number): Buffer {
  const b = Buffer.alloc(10);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}
function makeBmp(w: number, h: number): Buffer {
  const b = Buffer.alloc(26);
  b.write("BM", 0, "ascii");
  b.writeInt32LE(w, 18);
  b.writeInt32LE(h, 22);
  return b;
}

test("inspects PNG/GIF/BMP dimensions", () => {
  expect(inspectImage(makePng(200, 60))).toEqual({ format: "png", width: 200, height: 60 });
  expect(inspectImage(makeGif(320, 240))).toEqual({ format: "gif", width: 320, height: 240 });
  expect(inspectImage(makeBmp(640, 480))).toEqual({ format: "bmp", width: 640, height: 480 });
});

test("unknown bytes inspect to null", () => {
  expect(inspectImage(Buffer.from("not an image at all"))).toBeNull();
});

test("the 200x60 opencode-breaking image is routed to upscale, not sent", () => {
  const plan = planImage(makePng(200, 60));
  expect(plan.action).toBe("upscale");
  expect(plan.target).toEqual({ width: 667, height: 200 });
  expect(plan.reason).toContain("below provider minimum");
});

test("a well-sized image passes as ok", () => {
  expect(planImage(makePng(800, 600)).action).toBe("ok");
  expect(planImage(makePng(DEFAULT_IMAGE_LIMITS.maxEdge, DEFAULT_IMAGE_LIMITS.maxEdge)).action).toBe("ok");
});

test("an oversized image is downscaled within limits", () => {
  const plan = planImage(makePng(4000, 3000));
  expect(plan.action).toBe("downscale");
  expect(Math.max(plan.target!.width, plan.target!.height)).toBeLessThanOrEqual(
    DEFAULT_IMAGE_LIMITS.maxEdge,
  );
  expect(plan.target!.width * plan.target!.height).toBeLessThanOrEqual(DEFAULT_IMAGE_LIMITS.maxPixels);
});

test("unrecognized data is rejected with a placeholder", () => {
  const plan = planImage(Buffer.from("garbage"));
  expect(plan.action).toBe("reject");
  const text = imagePlaceholder(plan, "mystery.bin");
  expect(text).toContain("mystery.bin");
  expect(text).toContain("omitted");
});
