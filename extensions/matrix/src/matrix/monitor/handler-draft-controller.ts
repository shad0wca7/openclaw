import {
  createChannelProgressDraftCompositor,
  createLivePreviewLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import type { CoreConfig, MatrixConfig, MatrixStreamingMode, ReplyToMode } from "../../types.js";
import type { MatrixClient } from "../sdk.js";
import { formatMatrixToolProgressMarkdownCode } from "./handler-helpers.js";
import {
  loadMatrixDraftStream,
  loadMatrixSendModule,
  type MatrixDraftStreamHandle,
} from "./handler-runtime.js";
import { createMatrixToolGroups } from "./handler-tool-groups.js";
import type { BlockReplyContext, ReplyPayload } from "./runtime-api.js";

export async function createMatrixDraftController(params: {
  streaming: MatrixStreamingMode;
  /** Opted-in DMs retain conversation text and group activity independently. */
  conversationTimeline?: boolean;
  previewToolProgressEnabled: boolean;
  replyToMode: ReplyToMode;
  messageId: string;
  threadTarget?: string;
  accountConfig?: MatrixConfig;
  cfg: CoreConfig;
  accountId: string;
  roomId: string;
  client: MatrixClient;
  logVerboseMessage: (message: string) => void;
}) {
  const {
    streaming,
    previewToolProgressEnabled,
    replyToMode,
    messageId,
    threadTarget,
    accountConfig,
    cfg,
    accountId,
    roomId,
    client,
    logVerboseMessage,
  } = params;
  const draftStreamingEnabled = streaming !== "off";
  const quietDraftStreaming = streaming === "quiet" || streaming === "progress";
  const progressDraftStreaming = streaming === "progress";
  const hasRepliedRef = { value: false };
  const draftReplyToId = replyToMode !== "off" && !threadTarget ? messageId : undefined;
  const draftStream: MatrixDraftStreamHandle | undefined = draftStreamingEnabled
    ? await loadMatrixDraftStream().then(({ createMatrixDraftStream }) =>
        createMatrixDraftStream({
          roomId,
          client,
          cfg,
          mode: quietDraftStreaming ? "quiet" : "partial",
          threadId: threadTarget,
          replyToId: draftReplyToId,
          preserveReplyId: replyToMode === "all",
          ...(params.conversationTimeline ? { hasRepliedRef } : {}),
          accountId,
          log: logVerboseMessage,
        }),
      )
    : undefined;
  const conversationTimeline = params.conversationTimeline === true && Boolean(draftStream);
  let presentationTail: Promise<unknown> = Promise.resolve();
  let timelineFinished = false;
  const enqueuePresentation = <T>(operation: () => Promise<T>): Promise<T> => {
    if (!conversationTimeline) {
      return operation();
    }
    const result = presentationTail.then(operation);
    presentationTail = result.catch(() => undefined);
    return result;
  };
  const { createMatrixDraftStream } = conversationTimeline
    ? await loadMatrixDraftStream()
    : { createMatrixDraftStream: undefined };
  const createQuietStream = () => {
    if (!createMatrixDraftStream) {
      throw new Error("Matrix timeline is not enabled");
    }
    return createMatrixDraftStream({
      roomId,
      client,
      cfg,
      mode: "quiet",
      threadId: threadTarget,
      replyToId: draftReplyToId,
      preserveReplyId: replyToMode === "all",
      hasRepliedRef,
      accountId,
      log: logVerboseMessage,
    });
  };
  const toolGroups = conversationTimeline
    ? createMatrixToolGroups({
        createStream: createQuietStream,
        entry: accountConfig ?? cfg.channels?.matrix,
      })
    : undefined;
  let statusStream: MatrixDraftStreamHandle | undefined;
  const closeStatus = async () => {
    await statusStream?.stop();
    statusStream = undefined;
  };
  const unsettledTextPreviews: Array<{ eventId: string; text: string }> = [];
  const settleRetainedTextPreviews = async () => {
    if (!unsettledTextPreviews.length) {
      return;
    }
    const { editMessageMatrix } = await loadMatrixSendModule();
    for (const preview of unsettledTextPreviews.splice(0)) {
      try {
        await editMessageMatrix(roomId, preview.eventId, preview.text, {
          client,
          cfg,
          threadId: threadTarget,
          accountId,
          live: false,
          includeMentions: false,
        });
      } catch (error) {
        // Retain accepted conversation history if transport recovery also fails.
        logVerboseMessage(
          `matrix: retained preview ${preview.eventId} could not finalize: ${String(error)}`,
        );
      }
    }
  };
  // A pre-tool text preview belongs to that explanation, never to a later answer.
  const retainTimelineText = async () => {
    if (!conversationTimeline || !draftStream) {
      return;
    }
    await draftStream.stop();
    if (!(await draftStream.finalizeLive())) {
      const eventId = draftStream.eventId();
      const text = draftStream.text();
      if (eventId && text) {
        unsettledTextPreviews.push({ eventId, text });
      }
    }
    draftStream.reset();
    previewLifecycle.reset();
  };
  const shouldStreamPreviewToolProgress = Boolean(draftStream) && previewToolProgressEnabled;
  const shouldSuppressDefaultToolProgressMessages =
    Boolean(draftStream) && (shouldStreamPreviewToolProgress || params.streaming === "progress");
  type PendingDraftBoundary = {
    messageGeneration: number;
    endOffset: number;
  };
  // Track the current draft block start plus any queued block-end offsets
  // inside the model's cumulative partial text so multiple block
  // boundaries can drain in order even when Matrix delivery lags behind.
  let currentDraftMessageGeneration = 0;
  let currentDraftBlockOffset = 0;
  let latestDraftFullText = "";
  const pendingDraftBoundaries: PendingDraftBoundary[] = [];
  const latestQueuedDraftBoundaryOffsets = new Map<number, number>();
  let currentDraftReplyToId = draftReplyToId;
  const progressConfigEntry = accountConfig ?? cfg.channels?.matrix;
  const progressSeed = `${accountId}:${roomId}`;
  const progressDraft = createChannelProgressDraftCompositor({
    preparedItems: true,
    entry: progressConfigEntry,
    mode: streaming === "quiet" ? "partial" : streaming,
    active: Boolean(draftStream),
    seed: progressSeed,
    formatLine: formatMatrixToolProgressMarkdownCode,
    update: async (text, options) => {
      const previewText = text.replace(/^• /gmu, "- ");
      if (!draftStream) {
        return false;
      }
      if (conversationTimeline) {
        return await enqueuePresentation(async () => {
          if (timelineFinished) {
            return false;
          }
          await toolGroups?.closeGroup();
          statusStream ??= createQuietStream();
          if (statusStream.isStopped()) {
            return false;
          }
          statusStream.update(previewText);
          // Ungrouped outcomes also use this lane. An old event is not a
          // receipt for its pending edit; confirm the current text before
          // the caller may suppress its ordinary summary.
          await statusStream.flush();
          return (
            !statusStream.isStopped() &&
            Boolean(statusStream.eventId()) &&
            statusStream.matchesPreparedText(previewText)
          );
        });
      }
      draftStream.update(previewText);
      if (options?.flush) {
        await draftStream.flush();
      }
      // A queued update is not visible until Matrix has accepted a draft event.
      return Boolean(draftStream.eventId());
    },
    deleteCurrent: () =>
      conversationTimeline
        ? enqueuePresentation(async () => {
            await statusStream?.deleteCurrentMessage();
          })
        : draftStream?.deleteCurrentMessage(),
  });
  const previewLifecycle = createLivePreviewLifecycle<ReplyPayload, string>({
    draft: draftStream
      ? {
          flush: draftStream.flush,
          id: draftStream.eventId,
          seal: draftStream.seal,
          discardPending: draftStream.discardPending,
          clear: draftStream.clear,
        }
      : undefined,
    cleanupUndelivered: true,
    onFinalStarted: () => progressDraft.markFinalReplyStarted(),
    onFinalDelivered: () => progressDraft.markFinalReplyDelivered(),
    onCleanupFailure: (err) =>
      logVerboseMessage(`matrix draft preview cleanup failed: ${String(err)}`),
  });

  const buildPreviewToolProgressReplyOptions = (): Partial<GetReplyOptions> => {
    if (!shouldSuppressDefaultToolProgressMessages) {
      return {};
    }
    const onToolStart: NonNullable<GetReplyOptions["onToolStart"]> = async (payload) => {
      if (conversationTimeline && shouldStreamPreviewToolProgress) {
        return await enqueuePresentation(async () => {
          if (timelineFinished) {
            return false;
          }
          if ((payload.phase ?? "start") === "start" && !toolGroups!.hasTool(payload)) {
            progressDraft.beginNewTurn({ force: true });
            await closeStatus();
            await retainTimelineText();
          }
          return await toolGroups!.pushTool(payload);
        });
      }
      return await progressDraft.pushToolEvent(payload);
    };
    return {
      suppressDefaultToolProgressMessages: true,
      progressPreambleEnabled: true,
      commentaryProgressEnabled: progressDraft.commentaryProgressEnabled,
      onToolStart,
      onItemEvent: async (payload) => {
        // The durable commentary pipeline owns preambles; never echo them in a card.
        if (conversationTimeline) {
          if (payload.kind === "preamble" || payload.kind === "answer-candidate") {
            return false;
          }
          // Some providers expose native tool calls only as item events.
          if (payload.kind === "tool" && payload.phase === "start") {
            return await onToolStart(payload);
          }
          const accepted = await enqueuePresentation(async () =>
            timelineFinished ? false : await toolGroups!.pushItem(payload),
          );
          if (accepted) {
            return true;
          }
        }
        return await progressDraft.pushItemEvent(payload);
      },
      onPlanUpdate: async (payload) => {
        if (payload.phase !== "update") {
          return false;
        }
        return await progressDraft.pushPlanProgress(payload.steps, {
          explanation: payload.explanation,
          explanationFormat: payload.explanationFormat,
        });
      },
      onApprovalEvent: async (payload) => {
        return await progressDraft.pushApprovalEvent(payload);
      },
      onCommandOutput: async (payload) => {
        if (conversationTimeline) {
          const accepted = await enqueuePresentation(async () =>
            timelineFinished ? false : await toolGroups!.pushCommandOutput(payload),
          );
          if (accepted) {
            return true;
          }
        }
        return await progressDraft.pushCommandOutputEvent(payload);
      },
      onPatchSummary: async (payload) => {
        return await progressDraft.pushPatchEvent(payload);
      },
    };
  };

  const getDisplayableDraftText = () => {
    const nextDraftBoundaryOffset = pendingDraftBoundaries.find(
      (boundary) => boundary.messageGeneration === currentDraftMessageGeneration,
    )?.endOffset;
    if (nextDraftBoundaryOffset === undefined) {
      return latestDraftFullText.slice(currentDraftBlockOffset);
    }
    return latestDraftFullText.slice(currentDraftBlockOffset, nextDraftBoundaryOffset);
  };

  const updateDraftFromLatestFullText = () => {
    const blockText = getDisplayableDraftText();
    if (blockText) {
      draftStream?.update(blockText);
    }
  };

  const queueDraftBlockBoundary = (payload: ReplyPayload, context?: BlockReplyContext) => {
    const payloadTextLength = payload.text?.length ?? 0;
    const messageGeneration = context?.assistantMessageIndex ?? currentDraftMessageGeneration;
    const lastQueuedDraftBoundaryOffset =
      latestQueuedDraftBoundaryOffsets.get(messageGeneration) ?? 0;
    // Logical block boundaries must follow emitted block text, not whichever
    // later partial preview has already arrived by the time the async
    // boundary callback drains.
    const nextDraftBoundaryOffset = lastQueuedDraftBoundaryOffset + payloadTextLength;
    latestQueuedDraftBoundaryOffsets.set(messageGeneration, nextDraftBoundaryOffset);
    pendingDraftBoundaries.push({
      messageGeneration,
      endOffset: nextDraftBoundaryOffset,
    });
  };

  const advanceDraftBlockBoundary = (options?: { fallbackToLatestEnd?: boolean }) => {
    const completedBoundary = pendingDraftBoundaries.shift();
    if (completedBoundary) {
      if (
        !pendingDraftBoundaries.some(
          (entry) => entry.messageGeneration === completedBoundary.messageGeneration,
        )
      ) {
        latestQueuedDraftBoundaryOffsets.delete(completedBoundary.messageGeneration);
      }
      if (completedBoundary.messageGeneration === currentDraftMessageGeneration) {
        currentDraftBlockOffset = completedBoundary.endOffset;
      }
      return;
    }
    if (options?.fallbackToLatestEnd) {
      currentDraftBlockOffset = latestDraftFullText.length;
    }
  };

  const resetDraftBlockOffsets = () => {
    currentDraftMessageGeneration += 1;
    currentDraftBlockOffset = 0;
    latestDraftFullText = "";
  };

  const resetDraftDeliveryState = async () => {
    await toolGroups?.reset();
    await closeStatus();
    await settleRetainedTextPreviews();
    timelineFinished = false;
    await draftStream?.discardPending();
    draftStream?.reset();
    previewLifecycle.reset();
    currentDraftMessageGeneration = 0;
    currentDraftBlockOffset = 0;
    latestDraftFullText = "";
    pendingDraftBoundaries.length = 0;
    latestQueuedDraftBoundaryOffsets.clear();
    currentDraftReplyToId = draftReplyToId;
    progressDraft.beginNewTurn({ force: true });
  };

  const finalizeAcceptedPartialDraft = async () => {
    if (streaming !== "partial" || previewLifecycle.previewFinalized || !draftStream?.eventId()) {
      return;
    }
    // Only an already-visible partial may become the terminal reply. Drafts accepted
    // during shutdown stay active so the handler's final cleanup removes them.
    const draftEventId = await draftStream.stop().catch(() => undefined);
    if (draftEventId && (await draftStream.finalizeLive())) {
      previewLifecycle.retainPreview();
    }
  };

  const settleAcceptedDraftAfterError = async () => {
    if (previewLifecycle.previewFinalized || !draftStream?.eventId()) {
      return;
    }
    if (streaming === "partial") {
      await finalizeAcceptedPartialDraft();
      return;
    }
    // Quiet and progress previews are ordinary Matrix events rather than live
    // drafts. Preserve current behavior once Matrix has accepted the event.
    previewLifecycle.retainPreview();
  };

  return {
    draftStream,
    previewLifecycle,
    hasRepliedRef,
    conversationTimeline,
    enqueuePresentation,
    hasVisibleTool: (toolCallId: string) => toolGroups?.hasVisibleTool(toolCallId) === true,
    prepareTimelineDelivery: async (payload: ReplyPayload, kind: string) => {
      if (!conversationTimeline) {
        return;
      }
      // A retained timeline segment ends a status surface, not the turn.
      // Reopen its gate so later plans and approvals can still publish.
      progressDraft.beginNewTurn({ force: true });
      await toolGroups?.closeGroup();
      await closeStatus();
      if (kind === "final" && !payload.isCommentary) {
        timelineFinished = true;
        progressDraft.cancel();
        await toolGroups?.finish();
      }
    },
    cancelProgressDraft: () => {
      progressDraft.cancel();
      return enqueuePresentation(async () => {
        timelineFinished = true;
        await toolGroups?.finish();
        await closeStatus();
        await settleRetainedTextPreviews();
      });
    },
    buildPreviewToolProgressReplyOptions,
    queueDraftBlockBoundary,
    advanceDraftBlockBoundary,
    resetDraftBlockOffsets,
    beginAssistantMessage: () => progressDraft.beginAssistantMessage(),
    resetDraftDeliveryState: () => enqueuePresentation(resetDraftDeliveryState),
    updateDraftFromLatestFullText,
    finalizeAcceptedPartialDraft,
    settleAcceptedDraftAfterError,
    beginDraftGeneration: () => {
      previewLifecycle.reset();
      progressDraft.beginNewTurn({ force: true });
    },
    currentReplyToId: () =>
      conversationTimeline ? draftStream?.replyToId() : currentDraftReplyToId,
    setCurrentReplyToId: (replyToId: string | undefined) => {
      currentDraftReplyToId = replyToId;
    },
    resetReplyToIdForNextBlock: () => {
      currentDraftReplyToId = replyToMode === "all" ? draftReplyToId : undefined;
    },
    onPartialReply: (text: string) =>
      enqueuePresentation(async () => {
        if (progressDraftStreaming || timelineFinished) {
          return false;
        }
        if (conversationTimeline) {
          progressDraft.beginNewTurn({ force: true });
          await toolGroups?.closeGroup();
          await closeStatus();
        }
        latestDraftFullText = text;
        if (text.trim()) {
          progressDraft.resetActivity({ suppressed: true });
        }
        updateDraftFromLatestFullText();
        return false;
      }),
  };
}
