import type { ReplyPayload } from "../reply-payload.js";

type ToolProgressPayload = {
  itemId?: string;
  toolCallId?: string;
  status?: string;
  exitCode?: number | null;
};

type ToolProgressAcceptance = { visible: boolean; failed: boolean };
type ToolProgressState = {
  ids: Set<string>;
  latest: Promise<ToolProgressAcceptance>;
};

/** Per-turn receipts for suppressing only exact, visibly accepted activity echoes. */
export function createToolProgressEchoTracker(enabled: boolean) {
  const progressById = new Map<string, ToolProgressState>();
  const trackToolProgressCallback = <Payload extends ToolProgressPayload>(
    callback: ((payload: Payload) => Promise<boolean | void> | boolean | void) | undefined,
  ) => {
    if (!callback || !enabled) {
      return callback;
    }
    return (payload: Payload) => {
      const pending = (async () => await callback(payload))();
      const acceptance = pending.then(
        (result) => ({
          visible: result === true,
          failed:
            payload.status === "failed" ||
            payload.status === "error" ||
            payload.status === "declined" ||
            (typeof payload.exitCode === "number" && payload.exitCode !== 0),
        }),
        () => ({ visible: false, failed: false }),
      );
      const ids = [payload.toolCallId, payload.itemId].filter((id): id is string => Boolean(id));
      const progress = ids
        .map((id) => progressById.get(id))
        .find((entry) => entry !== undefined) ?? {
        ids: new Set<string>(),
        latest: acceptance,
      };
      for (const id of ids) {
        progress.ids.add(id);
        for (const alias of progressById.get(id)?.ids ?? []) {
          progress.ids.add(alias);
        }
      }
      // Both provider IDs name one call. Later events may carry only one alias;
      // their declined/rejected rendering must invalidate every earlier receipt.
      progress.latest = acceptance;
      for (const id of progress.ids) {
        progressById.set(id, progress);
      }
      return pending;
    };
  };
  const isVisibleToolProgressEcho = async (payload: ReplyPayload): Promise<boolean> => {
    const id = payload.channelData?.openclawToolProgressId;
    if (typeof id !== "string") {
      return false;
    }
    let pending = progressById.get(id)?.latest;
    while (pending) {
      const acceptance = await pending;
      const latest = progressById.get(id)?.latest;
      if (latest === pending) {
        return acceptance.visible && (payload.isError !== true || acceptance.failed);
      }
      // Completion order cannot restore an older receipt while a newer rendering
      // for this call is still pending.
      pending = latest;
    }
    return false;
  };
  return { trackToolProgressCallback, isVisibleToolProgressEcho };
}
