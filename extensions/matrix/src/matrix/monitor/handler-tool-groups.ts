import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import type { MatrixDraftStreamHandle } from "./handler-runtime.js";

type MatrixToolEvent = Parameters<NonNullable<GetReplyOptions["onToolStart"]>>[0] & {
  isError?: boolean;
};
type ToolState = "done" | "running" | "failed" | "cancelled";
type ToolCall = { state: ToolState; group: ToolGroup };
type ToolGroup = {
  name: string;
  label: string;
  stream: MatrixDraftStreamHandle;
  calls: Set<ToolCall>;
};

function toolLabel(name: string): string {
  // Only canonical identifier text belongs here, never arguments, result text,
  // mention syntax, or markup. Keep arbitrary provider names single-line/bounded.
  if (!/^[a-z0-9_.:/-]{1,160}$/i.test(name)) {
    return "Tool";
  }
  const leaf = name.split(/__|[.:/]/).at(-1) ?? name;
  const label = leaf.replace(/[_-]+/g, " ").trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : "Tool";
}

function renderGroup(group: ToolGroup): string {
  const counts: Record<ToolState, number> = { done: 0, running: 0, failed: 0, cancelled: 0 };
  for (const call of group.calls) {
    counts[call.state]++;
  }
  const states: ToolState[] = ["done", "running", "failed", "cancelled"];
  const totals = states
    .filter((state) => counts[state] > 0)
    .map((state) => `${counts[state]} ${state}`);
  return `${group.label} × ${group.calls.size} · ${totals.join(" · ")}`;
}

/** Consecutive activity membership; the caller owns presentation ordering. */
export function createMatrixToolGroups(params: { createStream: () => MatrixDraftStreamHandle }) {
  const callsById = new Map<string, ToolCall>();
  const groups: ToolGroup[] = [];
  let current: ToolGroup | undefined;
  let finished = false;

  const closeGroup = async (): Promise<void> => {
    const closed = current;
    current = undefined;
    // Membership is frozen, not results: a later completion still edits the
    // existing quiet message, never creates a backward activity group.
    await closed?.stream.flush();
  };

  const finish = async (): Promise<void> => {
    finished = true;
    current = undefined;
    for (const group of groups) {
      // A turn boundary says nothing about outcomes of unreported tool calls.
      await group.stream.stop();
    }
  };

  const pushTool = async (payload: MatrixToolEvent): Promise<boolean> => {
    if (finished) {
      return false;
    }
    const ids = [payload.toolCallId, payload.itemId].filter((id): id is string =>
      Boolean(id?.trim()),
    );
    if (!ids.length) {
      return false;
    }
    let call = ids.map((id) => callsById.get(id)).find((known) => known !== undefined);
    const phase = payload.phase ?? "start";
    if (!call) {
      const name = payload.name?.trim().toLowerCase();
      if (phase !== "start" || !name) {
        return false;
      }
      if (current?.name !== name) {
        await closeGroup();
        current = { name, label: toolLabel(name), stream: params.createStream(), calls: new Set() };
        groups.push(current);
      }
      call = { state: "running", group: current };
      current.calls.add(call);
    }
    for (const id of ids) {
      callsById.set(id, call);
    }
    if (phase === "result" && payload.isError) {
      call.state = "failed";
    } else if (call.state === "running") {
      if (phase === "result") {
        call.state = "done";
      } else if (phase === "cancelled" || phase === "canceled") {
        call.state = "cancelled";
      }
    }
    const { group } = call;
    if (group.stream.isStopped()) {
      return false;
    }
    const text = renderGroup(group);
    group.stream.update(text);
    if (
      !group.stream.eventId() ||
      phase === "result" ||
      phase === "cancelled" ||
      phase === "canceled"
    ) {
      // Outcomes require a confirmed counter edit before the caller may hide
      // their ordinary summary. Start/update bursts still use the throttle.
      await group.stream.flush();
      return (
        !group.stream.isStopped() &&
        Boolean(group.stream.eventId()) &&
        group.stream.matchesPreparedText(text)
      );
    }
    return true;
  };

  const pushOutcome = async (payload: {
    toolCallId?: string;
    itemId?: string;
    status?: string;
    exitCode?: number | null;
  }): Promise<boolean> => {
    if (![payload.toolCallId, payload.itemId].some((id) => id && callsById.has(id))) {
      return false;
    }
    const failed =
      payload.status === "failed" ||
      payload.status === "error" ||
      (typeof payload.exitCode === "number" && payload.exitCode !== 0);
    const cancelled = payload.status === "cancelled" || payload.status === "canceled";
    const done =
      payload.status === "completed" || payload.status === "done" || payload.exitCode === 0;
    return await pushTool({
      toolCallId: payload.toolCallId,
      itemId: payload.itemId,
      phase: failed || done ? "result" : cancelled ? "cancelled" : "update",
      ...(failed ? { isError: true } : {}),
    });
  };

  return {
    pushTool,
    pushItem: async (payload: Parameters<NonNullable<GetReplyOptions["onItemEvent"]>>[0]) =>
      await pushOutcome(payload),
    pushCommandOutput: async (
      payload: Parameters<NonNullable<GetReplyOptions["onCommandOutput"]>>[0],
    ) => await pushOutcome(payload),
    closeGroup,
    finish,
    reset: async (): Promise<void> => {
      await finish();
      callsById.clear();
      groups.length = 0;
      finished = false;
    },
    hasVisibleTool: (toolCallId: string): boolean =>
      Boolean(callsById.get(toolCallId)?.group.stream.eventId()),
  };
}
