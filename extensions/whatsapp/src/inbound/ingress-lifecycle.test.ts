import { describe, expect, it, vi } from "vitest";
import type { WhatsAppIngressLifecycle } from "./durable-receive.js";

describe("WhatsApp ingress lifecycle", () => {
  it("shares lifecycle identity across module instances", async () => {
    const lifecycle = {
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(async () => undefined),
      onAdoptionFinalizing: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(async () => undefined),
    } satisfies WhatsAppIngressLifecycle;
    const message = {};
    const first = await import("./ingress-lifecycle.js");

    first.attachWhatsAppIngressLifecycle(message, lifecycle);
    vi.resetModules();

    const second = await import("./ingress-lifecycle.js");
    expect(second.resolveWhatsAppIngressLifecycle).not.toBe(first.resolveWhatsAppIngressLifecycle);
    expect(second.resolveWhatsAppIngressLifecycle(message)).toBe(lifecycle);
  });
});
