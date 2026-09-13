import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { retireStandaloneGitWrapper } from "./update-command-git.js";
import { markControlPlaneUpdateRestartSentinelFailureBestEffort } from "./update-command-result.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import {
  createWindowsTaskAutoStartGuard,
  maybeStopManagedServiceBeforeMutableUpdate,
} from "./update-command-service-maintenance.js";
import {
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
  tryInstallShellCompletion,
} from "./update-command-service.js";

/** Shell integration changes follow settled restart and health recovery. */
export async function completePostUpdateMaintenance(
  params: FinishUpdateParams,
  result: UpdateRunResult,
  assertCurrent: () => void,
  context: {
    root: string;
    sentinel: Omit<
      Parameters<typeof markControlPlaneUpdateRestartSentinelFailureBestEffort>[0],
      "reason"
    >;
  },
): Promise<{ result: UpdateRunResult; detail: string } | undefined> {
  await tryInstallShellCompletion({
    root: context.root,
    jsonMode: Boolean(params.opts.json),
    skipPrompt: Boolean(params.opts.yes),
  });
  if (!params.installKindChanged || result.mode === "git") {
    return undefined;
  }
  const retirement = await retireStandaloneGitWrapper({
    previousRoot: params.previousInstallRoot ?? params.root,
    assertCurrent,
  });
  if (!retirement.error) {
    return undefined;
  }
  defaultRuntime.error(retirement.error);
  await markControlPlaneUpdateRestartSentinelFailureBestEffort({
    ...context.sentinel,
    reason: "wrapper-retirement-failed",
  });
  return {
    result: { ...result, status: "error", reason: "wrapper-retirement-failed" },
    detail: retirement.error,
  };
}

export async function resumePostUpdateWindowsAutoStart(
  params: Pick<FinishUpdateParams, "root" | "updateStepTimeoutMs">,
  result: UpdateRunResult,
  stopped: PreManagedServiceStop | undefined,
): Promise<void> {
  await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(
    stopped,
    true,
    stopped
      ? createWindowsTaskAutoStartGuard({
          root:
            result.recovery?.packageRollbackVerified &&
            stopped.serviceUpdateVerdict?.kind === "owned"
              ? stopped.serviceUpdateVerdict.root
              : (result.root ?? params.root),
          before: stopped,
          timeoutMs: params.updateStepTimeoutMs,
        })
      : undefined,
  );
}

/** Retain custody through fresh runtime finalization: prove the current native owner is
 * still offline before target-runtime maintenance, not just at the recorded stop. */
export async function parkManagedServiceForPostUpdate(params: {
  before: PreManagedServiceStop;
  updateRun?: UpdateCommandOptions["run"];
  updateInstallKind: "git" | "package";
  root: string;
  jsonMode: boolean;
  timeoutMs?: number;
  onStopped: (state: PreManagedServiceStop) => void;
}): Promise<PreManagedServiceStop> {
  const { before, onStopped, ...stopParams } = params;
  const preparation = {
    ...stopParams,
    shouldRestart: true,
    expectedService: before,
    // The verified target can replace its package root before the exact retained
    // native launcher is refreshed. The service owner still checks its fingerprint.
    allowInstallRootChange: true,
  };
  // A recorded stop is historical. The supervisor may have respawned while
  // target validation ran, so prove the current native owner is still offline.
  const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
    ...preparation,
    phase: "inspect",
  });
  if (inspected.blockMessage || inspected.serviceUpdateVerdict?.kind !== "owned") {
    throw new Error(inspected.blockMessage ?? "Plugin maintenance lost its update service owner.");
  }
  if (inspected.offline === true) {
    // Keep the original Windows suspension and downtime custody until activation.
    return before;
  }
  await before.windowsTaskAutoStartRecovery?.complete(true);
  // Retain this suspension through target-runtime maintenance and verified activation.
  const stopped = await maybeStopManagedServiceBeforeMutableUpdate({
    ...preparation,
    phase: "prepare",
    onStopped,
  });
  onStopped(stopped);
  before.windowsTaskAutoStartRecovery = stopped.windowsTaskAutoStartRecovery;
  if (stopped.blockMessage || !stopped.stopped) {
    throw new Error(stopped.blockMessage ?? "Gateway could not be parked for plugin maintenance.");
  }
  stopped.windowsTaskAutoStartRecovery?.beginMutation();
  return stopped;
}
