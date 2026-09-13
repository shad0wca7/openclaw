import { afterEach, describe, expect, it, vi } from "vitest";
import { readSubagentOutput, testing } from "./subagent-announce-output.test-support.js";

type CallGateway = typeof import("../../../gateway/call.js").callGateway;

function installOutputDeps(params: { messages: unknown[] }) {
  testing.setDepsForTest({
    callGateway: vi.fn(async () => ({ messages: params.messages })) as unknown as CallGateway,
  });
}

describe("run-linked subagent completion evidence", () => {
  afterEach(() => testing.setDepsForTest());
  it("recovers only the requested run's terminal reply, not a newer session reply", async () => {
    installOutputDeps({
      messages: [
        {
          role: "assistant",
          stopReason: "stop",
          content: "Original final",
          __openclaw: { runId: "run-original", runTerminal: true },
        },
        {
          role: "assistant",
          stopReason: "stop",
          content: "Newer final",
          __openclaw: { runId: "run-newer", runTerminal: true },
        },
      ],
    });
    await expect(readSubagentOutput("child", undefined, { runId: "run-original" })).resolves.toBe(
      "Original final",
    );
  });

  it("does not recover an earlier final when the same run continued with tools", async () => {
    installOutputDeps({
      messages: [
        {
          role: "assistant",
          stopReason: "stop",
          content: "Earlier final",
          __openclaw: { runId: "run" },
        },
        {
          role: "assistant",
          stopReason: "toolUse",
          content: "Continued work",
          __openclaw: { runId: "run" },
        },
      ],
    });
    await expect(readSubagentOutput("child", undefined, { runId: "run" })).resolves.toBeUndefined();
  });

  it.each([
    { role: "assistant", stopReason: "stop", content: "Unlinked final" },
    {
      role: "assistant",
      stopReason: "stop",
      content: "Foreign final",
      __openclaw: { runId: "foreign", runTerminal: true },
    },
    {
      role: "assistant",
      stopReason: "stop",
      content: [
        {
          type: "text",
          text: "Commentary",
          textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
        },
      ],
      __openclaw: { runId: "expected" },
    },
    {
      role: "assistant",
      stopReason: "toolUse",
      content: "Still working",
      __openclaw: { runId: "expected" },
    },
    {
      role: "assistant",
      stopReason: "error",
      content: "Failed",
      __openclaw: { runId: "expected" },
    },
    {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "toolCall", name: "exec" },
        { type: "text", text: "Working" },
      ],
      __openclaw: { runId: "expected" },
    },
    {
      role: "assistant",
      stopReason: "stop",
      content: "Mirrored commentary",
      __openclaw: { runId: "expected", mirrorOrigin: "codex-app-server" },
    },
  ])("rejects nonterminal or unlinked completion evidence: %j", async (message) => {
    installOutputDeps({ messages: [message] });
    await expect(
      readSubagentOutput("child", undefined, { runId: "expected" }),
    ).resolves.toBeUndefined();
  });
});
