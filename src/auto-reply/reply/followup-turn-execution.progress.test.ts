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

  it.each(["on", "full"] as const)(
    "leaves queued verbose %s results to the channel delivery owner",
    async (verboseLevel) => {
      const summary: ReplyPayload =
        verboseLevel === "full"
          ? { text: "Bash\n```txt\nfull diagnostic output\n```" }
          : {
              text: "Bash",
              channelData: { openclawToolProgressId: "call-1" },
            };
      const turn = createTurn();
      turn.queued.run.verboseLevelOverride = verboseLevel;
      const onToolResult = vi.fn(async () => {});
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        await params.opts?.onToolStart?.({ toolCallId: "call-1", name: "bash", phase: "start" });
        await params.opts?.onToolResult?.(summary);
        return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
      });
      const result = await executeFollowupTurn({
        turn,
        defaults: {
          typing: createTypingController(),
          typingMode: "never",
          defaultModel: "claude",
          opts: { suppressDefaultToolProgressMessages: true, onToolStart: () => true },
        },
        onToolResult,
        onCompactionNoticePayload: vi.fn(async () => {}),
      });
      await result.progress.drain();
      expect(onToolResult).toHaveBeenCalledExactlyOnceWith(summary, { runId: "run-1" });
    },
  );
});
