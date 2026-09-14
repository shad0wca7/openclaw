import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatrixDraftStream } from "../draft-stream.js";
import type { MatrixClient } from "../sdk.js";
import { createMatrixToolGroups } from "./handler-tool-groups.js";

const transport = vi.hoisted(() => ({
  send: vi.fn(),
  edit: vi.fn(),
}));

vi.mock("../send.js", () => ({
  prepareMatrixSingleText: (text: string) => ({
    trimmedText: text,
    convertedText: text,
    singleEventLimit: 4000,
    fitsInSingleEvent: text.length <= 4000,
  }),
  sendSingleTextMessageMatrix: transport.send,
  editMessageMatrix: transport.edit,
}));

type ToolEvent = Parameters<NonNullable<GetReplyOptions["onToolStart"]>>[0];

function createGroups() {
  const createStream = vi.fn(() =>
    createMatrixDraftStream({
      roomId: "!room:example.org",
      client: {} as MatrixClient,
      cfg: {},
      mode: "quiet",
    }),
  );
  return { groups: createMatrixToolGroups({ createStream }), createStream };
}

function start(name: string, toolCallId: string, extra: Partial<ToolEvent> = {}): ToolEvent {
  return { name, toolCallId, phase: "start", ...extra };
}

describe("Matrix consecutive tool groups", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    let eventId = 0;
    transport.send
      .mockReset()
      .mockImplementation(async () => ({ messageId: `$tool-${++eventId}` }));
    transport.edit.mockReset().mockResolvedValue("$edit");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["exec", "read", "web_search", "automations", "mcp__example__lookup"])(
    "counts unique consecutive %s calls and batches edits through the draft throttle",
    async (name) => {
      const { groups, createStream } = createGroups();
      expect(await groups.pushTool(start(name, "one"))).toBe(true);
      expect(transport.send).toHaveBeenCalledOnce();
      expect(transport.send.mock.calls[0]?.[1]).toContain("× 1 · 1 running");
      expect(transport.send.mock.calls[0]?.[2]).toMatchObject({
        msgtype: "m.notice",
        includeMentions: false,
        live: false,
      });

      expect(await groups.pushTool(start(name, "two"))).toBe(true);
      expect(await groups.pushTool(start(name, "three"))).toBe(true);
      expect(transport.edit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(transport.edit).toHaveBeenCalledExactlyOnceWith(
        "!room:example.org",
        "$tool-1",
        expect.stringContaining("× 3 · 3 running"),
        expect.objectContaining({ msgtype: "m.notice", includeMentions: false, live: false }),
      );
      expect(createStream).toHaveBeenCalledOnce();
      await groups.finish();
    },
  );

  it("flushes before type switches and starts a fresh group after conversational boundaries", async () => {
    const { groups } = createGroups();
    await groups.pushTool(start("read", "read-one"));
    await groups.pushTool(start("read", "read-two"));
    await groups.pushTool(start("exec", "exec-one"));
    expect(transport.edit.mock.calls[0]?.[2]).toBe("Read × 2 · 2 running");
    expect(transport.edit.mock.invocationCallOrder[0]).toBeLessThan(
      transport.send.mock.invocationCallOrder[1]!,
    );
    await groups.closeGroup();
    await groups.pushTool(start("exec", "exec-two"));
    await groups.pushTool(start("read", "read-three"));
    expect(transport.send.mock.calls.map((call) => call[1])).toEqual([
      "Read × 1 · 1 running",
      "Exec × 1 · 1 running",
      "Exec × 1 · 1 running",
      "Read × 1 · 1 running",
    ]);
    await groups.finish();
  });

  it("deduplicates both ID aliases and applies results to closed groups without adding calls", async () => {
    const { groups } = createGroups();
    await groups.pushTool(start("read", "call-one", { itemId: "item-one" }));
    await groups.pushTool({ itemId: "item-one", name: "read", phase: "update" });
    await groups.pushTool(start("read", "call-one"));
    await groups.pushTool(start("exec", "call-two"));
    expect(await groups.pushTool({ toolCallId: "call-one", phase: "result", isError: true })).toBe(
      true,
    );
    expect(transport.edit.mock.calls.at(-1)?.slice(1, 3)).toEqual([
      "$tool-1",
      "Read × 1 · 1 failed",
    ]);
    await groups.pushTool({ itemId: "item-one", phase: "result", isError: false });
    await groups.finish();
    expect(transport.send).toHaveBeenCalledTimes(2);
    expect(transport.edit.mock.calls.at(-1)?.[2]).toBe("Read × 1 · 1 failed");
    expect(groups.hasVisibleTool("call-one")).toBe(true);
    expect(groups.hasVisibleTool("item-one")).toBe(true);
  });

  it("shows explicit outcomes and leaves unknown results running at finish", async () => {
    const { groups } = createGroups();
    for (const id of ["done", "failed", "cancelled", "unknown"]) {
      await groups.pushTool(start("automations", id));
    }
    await groups.pushTool({ toolCallId: "done", phase: "result", isError: false });
    await groups.pushTool({ toolCallId: "failed", phase: "result", isError: true });
    await groups.pushTool({ toolCallId: "cancelled", phase: "cancelled" });
    await groups.finish();
    expect(transport.edit.mock.calls.at(-1)?.[2]).toBe(
      "Automations × 4 · 1 done · 1 running · 1 failed · 1 cancelled",
    );
    const sent = transport.send.mock.calls.length;
    const edited = transport.edit.mock.calls.length;
    expect(await groups.pushTool(start("read", "late"))).toBe(false);
    expect(await groups.pushTool({ toolCallId: "unknown", phase: "result" })).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.send).toHaveBeenCalledTimes(sent);
    expect(transport.edit).toHaveBeenCalledTimes(edited);
  });

  it("declines uncorrelated updates and never prints arguments or unsafe tool labels", async () => {
    const { groups, createStream } = createGroups();
    expect(await groups.pushTool({ name: "read", phase: "start" })).toBe(false);
    expect(await groups.pushTool({ name: "read", toolCallId: "unknown", phase: "update" })).toBe(
      false,
    );
    expect(await groups.pushTool({ toolCallId: "unnamed", phase: "start" })).toBe(false);
    expect(createStream).not.toHaveBeenCalled();
    await groups.pushTool(
      start("mcp__example__web_search", "safe", { args: { token: "private" } }),
    );
    expect(transport.send.mock.calls.at(-1)?.[1]).toBe("Web search × 1 · 1 running");
    await groups.pushTool(start("<b>@room</b>\nSECRET", "unsafe"));
    expect(transport.send.mock.calls.at(-1)?.[1]).toBe("Tool × 1 · 1 running");
    await groups.finish();
  });

  it("does not accept invisible first sends, preserving the normal summary fallback", async () => {
    transport.send.mockRejectedValueOnce(new Error("offline"));
    const { groups } = createGroups();
    expect(await groups.pushTool(start("read", "failed-send"))).toBe(false);
    expect(groups.hasVisibleTool("failed-send")).toBe(false);
    expect(await groups.pushTool({ toolCallId: "failed-send", phase: "result" })).toBe(false);
    await groups.closeGroup();
    expect(await groups.pushTool(start("read", "next-call"))).toBe(true);
    await groups.finish();
  });

  it("declines later results when a throttled counter edit stopped the stream", async () => {
    const { groups } = createGroups();
    await groups.pushTool(start("bash", "one"));
    await groups.pushTool(start("bash", "two"));
    transport.edit.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await groups.pushItem({ toolCallId: "two", phase: "end", status: "completed" })).toBe(
      false,
    );
    expect(await groups.pushTool(start("bash", "three"))).toBe(false);
    await groups.finish();
  });

  it("declines failed error edits even when an earlier running message is visible", async () => {
    const { groups } = createGroups();
    await groups.pushTool(start("exec", "failed-edit"));
    transport.edit.mockRejectedValueOnce(new Error("offline"));
    expect(
      await groups.pushTool({ toolCallId: "failed-edit", phase: "result", isError: true }),
    ).toBe(false);
    await groups.finish();
    expect(transport.send).toHaveBeenCalledOnce();
  });

  it("settles correlated item and command output once without splitting Bash groups", async () => {
    const { groups } = createGroups();
    await groups.pushTool(start("bash", "one", { itemId: "item-one" }));
    expect(
      await groups.pushItem({ toolCallId: "one", kind: "tool", phase: "end", status: "completed" }),
    ).toBe(true);
    expect(await groups.pushCommandOutput({ itemId: "item-one", phase: "end", exitCode: 0 })).toBe(
      true,
    );
    await groups.pushTool(start("bash", "two"));
    expect(await groups.pushCommandOutput({ toolCallId: "two", phase: "end", exitCode: 2 })).toBe(
      true,
    );
    await groups.pushItem({ toolCallId: "two", kind: "tool", phase: "end", status: "completed" });
    await groups.pushTool(start("bash", "unknown"));
    await groups.pushCommandOutput({ toolCallId: "unknown", phase: "update", status: "running" });
    expect(
      await groups.pushCommandOutput({ toolCallId: "absent", phase: "end", exitCode: 1 }),
    ).toBe(false);
    await groups.finish();
    expect(transport.send).toHaveBeenCalledOnce();
    expect(transport.edit.mock.calls.at(-1)?.[2]).toBe("Bash × 3 · 1 done · 1 running · 1 failed");
  });

  it("resets turn-local IDs without editing or deleting retained history", async () => {
    const { groups } = createGroups();
    await groups.pushTool(start("read", "same-id"));
    await groups.pushTool(start("read", "second-id"));
    await groups.reset();
    expect(transport.edit.mock.calls.at(-1)?.[2]).toBe("Read × 2 · 2 running");
    expect(groups.hasVisibleTool("same-id")).toBe(false);
    expect(await groups.pushTool(start("read", "same-id"))).toBe(true);
    expect(transport.send).toHaveBeenCalledTimes(2);
    await groups.finish();
  });
});
