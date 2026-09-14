import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ReplyPayload } from "../types.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import {
  createFollowupTurnTestTypingController as createTypingController,
  createFollowupTurnTestTurn as createTurn,
  executeFollowupTurnForTest as executeFollowupTurn,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";

const state = getFollowupTurnTestState();
beforeEach(resetFollowupTurnTestState);

describe("executeFollowupTurn progress ownership", () => {
  it.each(["off", "on"] as const)(
    "keeps queued completed native commentary ahead of activity when verbose is %s",
    async (verboseLevel) => {
      const commentaryDelivery = createDeferred();
      const order: string[] = [];
      const onToolResult = vi.fn(async () => {});
      const turn = createTurn();
      turn.queued.run.verboseLevelOverride = verboseLevel;
      const onCommentaryPayload = vi.fn(async (payload: ReplyPayload) => {
        await commentaryDelivery.promise;
        order.push(payload.text!);
      });
      const onToolStart = vi.fn(() => {
        order.push("activity");
        return true;
      });
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        const preamble = {
          itemId: "commentary-1",
          kind: "preamble",
          phase: "end",
          progressText: "Checking the queued request.",
        };
        await params.opts?.onItemEvent?.({
          ...preamble,
          phase: "update",
          progressText: "Checking",
        });
        expect(onCommentaryPayload).not.toHaveBeenCalled();
        const completed = params.opts?.onItemEvent?.(preamble);
        const duplicate = params.opts?.onItemEvent?.(preamble);
        const activity = params.opts?.onToolStart?.({ toolCallId: "call-1", phase: "start" });
        try {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(onToolStart).not.toHaveBeenCalled();
        } finally {
          commentaryDelivery.resolve();
        }
        await Promise.all([completed, duplicate, activity]);
        order.push("final");
        return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
      });

      const result = await executeFollowupTurn({
        turn,
        defaults: {
          typing: createTypingController(),
          typingMode: "never",
          defaultModel: "claude",
          opts: {
            commentaryPayloadsEnabled: true,
            suppressDefaultToolProgressMessages: true,
            onItemEvent: () => false,
            onToolStart,
          },
        },
        onToolResult,
        onCommentaryPayload,
        onCompactionNoticePayload: vi.fn(async () => {}),
      });
      await result.progress.drain();

      expect(onCommentaryPayload).toHaveBeenCalledExactlyOnceWith(
        { text: "Checking the queued request.", isCommentary: true },
        { runId: "run-1" },
      );
      expect(onToolResult).not.toHaveBeenCalled();
      expect(order).toEqual(["Checking the queued request.", "activity", "final"]);
    },
  );

  it.each(["draft-owner", "cli-suppressed", "send-denied", "room-event", "message-tool-only"])(
    "preserves queued native commentary suppression for %s",
    async (reason) => {
      const turn = createTurn({ sendPolicy: reason === "send-denied" ? "deny" : "allow" });
      turn.queued.run.verboseLevelOverride = "off";
      if (reason === "room-event") {
        turn.queued.currentInboundEventKind = "room_event";
      }
      if (reason === "message-tool-only") {
        turn.queued.run.sourceReplyDeliveryMode = "message_tool_only";
      }
      const onCommentaryPayload = vi.fn(async () => {});
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        await params.opts?.onItemEvent?.({
          itemId: "commentary-1",
          kind: "preamble",
          phase: "end",
          progressText: "Checking the queued request.",
          ...(reason === "cli-suppressed" ? { suppressDurableProgress: true } : {}),
        });
        return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
      });

      const result = await executeFollowupTurn({
        turn,
        defaults: {
          typing: createTypingController(),
          typingMode: "never",
          defaultModel: "claude",
          opts: {
            commentaryPayloadsEnabled: true,
            shouldDeliverCommentaryPayloads: () => reason !== "draft-owner",
          },
        },
        onToolResult: vi.fn(async () => {}),
        onCommentaryPayload,
        onCompactionNoticePayload: vi.fn(async () => {}),
      });
      await result.progress.drain();

      expect(onCommentaryPayload).not.toHaveBeenCalled();
    },
  );

  it.each([
    { source: "tool", accepted: true, suppressed: true },
    { source: "tool", accepted: false, suppressed: false },
    { source: "tool", accepted: undefined, suppressed: false },
    { source: "item", accepted: true, suppressed: true },
    { source: "item", accepted: undefined, suppressed: false },
    { source: "command", accepted: true, suppressed: true },
    { source: "command", accepted: undefined, suppressed: false },
  ] as const)(
    "dedupes queued correlated $source summaries only after explicit acceptance ($accepted)",
    async ({ source, accepted, suppressed }) => {
      const echo: ReplyPayload = {
        text: "Bash",
        channelData: { openclawToolProgressId: "call-1" },
      };
      const unmatched: ReplyPayload = {
        ...echo,
        channelData: { openclawToolProgressId: "call-2" },
      };
      const onDurableToolResult = vi.fn(async () => {});
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        expect(params.shouldEmitToolResult()).toBe(true);
        if (source === "tool") {
          await params.opts?.onToolStart?.({ toolCallId: "call-1", name: "bash", phase: "start" });
        } else if (source === "item") {
          await params.opts?.onItemEvent?.({ itemId: "call-1", kind: "tool", phase: "start" });
        } else {
          await params.opts?.onCommandOutput?.({ toolCallId: "call-1", phase: "end", exitCode: 0 });
        }
        await params.opts?.onToolResult?.(echo);
        await params.opts?.onToolResult?.(unmatched);
        return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
      });

      const result = await executeFollowupTurn({
        turn: createTurn(),
        defaults: {
          typing: createTypingController(),
          typingMode: "never",
          defaultModel: "claude",
          opts: {
            suppressDefaultToolProgressMessages: true,
            onToolStart: () => accepted,
            onItemEvent: async () => accepted,
            onCommandOutput: () => accepted,
          },
        },
        onToolResult: onDurableToolResult,
        onCompactionNoticePayload: vi.fn(async () => {}),
      });
      await result.progress.drain();

      expect(onDurableToolResult.mock.calls).toEqual(
        (suppressed ? [unmatched] : [echo, unmatched]).map((payload) => [
          payload,
          { runId: "run-1" },
        ]),
      );
    },
  );

  it.each([false, true])(
    "keeps queued durable results and unrendered failures after accepted activity (failed outcome=%s)",
    async (failedOutcomeVisible) => {
      const failed: ReplyPayload = {
        text: "Command failed",
        isError: true,
        channelData: { openclawToolProgressId: "call-1" },
      };
      const progressData = { openclawToolProgressId: "call-1" };
      const durable: ReplyPayload[] = [
        { mediaUrl: "https://example.com/result.png", channelData: progressData },
        { channelData: { ...progressData, execApproval: { approvalId: "approval-1" } } },
        { channelData: { ...progressData, execApprovalUnavailable: { reason: "no-route" } } },
        { channelData: { ...progressData, askUser: { questionId: "question-1" } } },
      ];
      const onDurableToolResult = vi.fn(async () => {});
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        await params.opts?.onToolStart?.({ toolCallId: "call-1", name: "bash", phase: "start" });
        await params.opts?.onToolResult?.(failed);
        await params.opts?.onCommandOutput?.({ toolCallId: "call-1", phase: "end", exitCode: 1 });
        await params.opts?.onToolResult?.(failed);
        for (const payload of durable) {
          await params.opts?.onToolResult?.(payload);
        }
        return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
      });

      const result = await executeFollowupTurn({
        turn: createTurn(),
        defaults: {
          typing: createTypingController(),
          typingMode: "never",
          defaultModel: "claude",
          opts: {
            suppressDefaultToolProgressMessages: true,
            onToolStart: () => true,
            onCommandOutput: () => failedOutcomeVisible,
          },
        },
        onToolResult: onDurableToolResult,
        onCompactionNoticePayload: vi.fn(async () => {}),
      });
      await result.progress.drain();

      expect(onDurableToolResult.mock.calls).toEqual(
        [failed, ...(failedOutcomeVisible ? [] : [failed]), ...durable].map((payload) => [
          payload,
          { runId: "run-1" },
        ]),
      );
    },
  );

  it.each([false, "reject"] as const)(
    "restores queued verbose fallback after terminal rendering returns %s",
    async (terminalResult) => {
      const echo: ReplyPayload = {
        text: "Bash completed",
        channelData: { openclawToolProgressId: "call-1" },
      };
      const onDurableToolResult = vi.fn(async () => {});
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        await params.opts?.onToolStart?.({ toolCallId: "call-1", phase: "start" });
        await params.opts?.onItemEvent?.({ toolCallId: "call-1", kind: "tool", phase: "end" });
        await params.opts?.onToolResult?.(echo);
        return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
      });

      const result = await executeFollowupTurn({
        turn: createTurn(),
        defaults: {
          typing: createTypingController(),
          typingMode: "never",
          defaultModel: "claude",
          opts: {
            suppressDefaultToolProgressMessages: true,
            onToolStart: () => true,
            onItemEvent: async () => {
              if (terminalResult === "reject") {
                throw new Error("terminal rendering failed");
              }
              return terminalResult;
            },
          },
        },
        onToolResult: onDurableToolResult,
        onCompactionNoticePayload: vi.fn(async () => {}),
      });
      if (terminalResult === "reject") {
        await expect(result.progress.drain()).rejects.toThrow("terminal rendering failed");
      } else {
        await result.progress.drain();
      }

      expect(onDurableToolResult.mock.calls).toEqual([[echo, { runId: "run-1" }]]);
    },
  );
});
