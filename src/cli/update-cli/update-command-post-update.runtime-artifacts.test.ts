import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as postCoreModule from "./update-command-post-core.js";
import {
  createManagedServiceIdentityFixture,
  finishSuccessfulPackageSwitch,
  managedServiceState,
  successfulPluginUpdate,
  taskRecovery,
  validConfigSnapshot,
} from "./update-command-post-update.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mocks = vi.hoisted(() => ({
  completePluginUpdate: vi.fn(),
  completeRuntime: vi.fn(),
  leaseActive: false,
  readServiceState: vi.fn(),
  restartService: vi.fn<typeof import("./update-command-service.js").maybeRestartService>(),
  stopService: vi.fn(),
  updatePlugins: vi.fn(),
}));
vi.mock("./progress.js", () => ({ printResult: vi.fn() }));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: async () => validConfigSnapshot,
}));
vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  createConfigIO: () => ({ readBestEffortConfig: async () => ({}) }),
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  readGatewayServiceState: mocks.readServiceState,
}));
vi.mock("../../commands/doctor-completion.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/doctor-completion.js")>()),
  checkShellCompletionStatus: vi.fn(),
  ensureCompletionCacheExists: vi.fn(),
}));
vi.mock("../../plugins/plugin-lifecycle-lease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/plugin-lifecycle-lease.js")>();
  const withPluginLifecycleLease: typeof actual.withPluginLifecycleLease = (params, callback) =>
    actual.withPluginLifecycleLease(params, async (lease) => {
      const leaseWasActive = mocks.leaseActive;
      mocks.leaseActive = true;
      try {
        return await callback(lease);
      } finally {
        mocks.leaseActive = leaseWasActive;
      }
    });
  return { ...actual, withPluginLifecycleLease };
});
vi.mock("../../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecords: async () => ({}),
}));
vi.mock("./update-command-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-config.js")>()),
  preparePostCorePluginConfig: async () => ({
    configSnapshot: validConfigSnapshot,
    configWriteOptions: {},
    configChanged: false,
    restoredAuthoredChannels: [],
  }),
}));
vi.mock("./update-command-fresh-doctor.js", () => ({
  completePostCorePluginUpdate: mocks.completePluginUpdate,
}));
vi.mock("./update-command-plugins.js", () => ({
  updatePluginsAfterCoreUpdate: mocks.updatePlugins,
}));
vi.mock("./update-command-runtime.js", () => ({
  completeSourceUpdateRuntime: mocks.completeRuntime,
}));
vi.mock("./restart-helper.js", () => ({ prepareRestartScript: async () => null }));
vi.mock("./update-command-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service.js")>()),
  maybeRestartService: mocks.restartService,
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stopService,
  revalidateManagedGatewayServiceAfterUpdate: async ({ root }: { root: string }) => ({
    kind: "owned",
    root,
    fingerprint: "sealed",
    refreshDefinition: false,
  }),
}));
vi.mock("./update-command-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-result.js")>()),
  writeControlPlaneUpdateRestartSentinelBestEffort: async () => undefined,
}));

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  { scenario: "current-core runtime repair", fresh: false, initiallyRunning: true },
  { scenario: "fresh child after the service respawned", fresh: true, initiallyRunning: true },
  {
    scenario: "fresh child retaining the original stopped interval",
    fresh: true,
    initiallyRunning: false,
  },
])(
  "parks before $scenario and retains Doctor plus verified restart",
  async ({ fresh, initiallyRunning }) => {
    vi.clearAllMocks();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    const identity = createManagedServiceIdentityFixture(tempDirs.make("current-runtime-repair-"));
    const order: string[] = [];
    let running = initiallyRunning;
    const originalRecovery = taskRecovery();
    vi.spyOn(postCoreModule, "shouldResumePostCoreUpdateInFreshProcess").mockReturnValue(fresh);
    const targetRoot = fresh ? "/tmp/openclaw-new-package" : "/tmp/openclaw-update";
    const verdict = {
      kind: "owned" as const,
      root: "/tmp/openclaw-update",
      fingerprint: "sealed",
      refreshDefinition: fresh,
    };
    mocks.readServiceState.mockResolvedValue(managedServiceState(process.env));
    mocks.stopService.mockImplementation(
      async ({ phase, root, expectedService, allowInstallRootChange }) => {
        expect(root).toBe(targetRoot);
        expect(expectedService.serviceUpdateVerdict).toEqual(verdict);
        expect(allowInstallRootChange).toBe(true);
        if (phase === "inspect") {
          order.push("inspect");
          return {
            running,
            offline: !running,
            stopped: false,
            inspected: true,
            runtimeInspected: true,
            serviceUpdateVerdict: verdict,
          };
        }
        expect(running).toBe(true);
        running = false;
        order.push("stop");
        return {
          running: true,
          stopped: true,
          inspected: true,
          runtimeInspected: true,
          serviceUpdateVerdict: verdict,
        };
      },
    );
    const freshChild = vi
      .spyOn(postCoreModule, "continuePostCoreUpdateInFreshProcess")
      .mockImplementation(async () => {
        expect(running).toBe(false);
        expect(mocks.leaseActive).toBe(false);
        if (!initiallyRunning) {
          expect(originalRecovery.complete).not.toHaveBeenCalled();
          expect(originalRecovery.restore).not.toHaveBeenCalled();
        }
        order.push("fresh-child");
        return {
          resumed: true,
          pluginUpdate: { ...successfulPluginUpdate, status: "skipped", changed: true },
        };
      });
    mocks.completeRuntime.mockImplementation(
      async (params: { beforePublication?: () => Promise<void> }) => {
        await params.beforePublication?.();
        expect(running).toBe(false);
        order.push("publication");
        return { changed: true };
      },
    );
    mocks.updatePlugins.mockImplementation(async () => {
      order.push("plugins");
      return { ...successfulPluginUpdate, status: "skipped", changed: false };
    });
    mocks.completePluginUpdate.mockImplementation(async (params) => {
      expect(mocks.leaseActive).toBe(false);
      expect(params.freshDoctorRequired).toBe(true);
      expect(params.pluginUpdate).toMatchObject({ status: "skipped", changed: true });
      await params.beforeDoctor?.();
      order.push("doctor");
      return { pluginUpdate: params.pluginUpdate, configSnapshot: validConfigSnapshot };
    });
    mocks.restartService.mockImplementation(async () => {
      expect(running).toBe(false);
      order.push("restart-verify");
      running = true;
      return "ok";
    });
    try {
      await finishSuccessfulPackageSwitch(
        { restartEnvironment: process.env, packageRoot: targetRoot, previousRoot: verdict.root },
        {
          coreAlreadyCurrent: !fresh,
          preManagedServiceStop: {
            running: true,
            stopped: fresh,
            serviceUpdateVerdict: verdict,
            windowsTaskAutoStartRecovery: originalRecovery,
          },
          result: {
            status: fresh ? "ok" : "skipped",
            ...(!fresh ? { reason: "already-current" } : {}),
            mode: "git",
            root: targetRoot,
            steps: [],
            durationMs: 1,
          },
        },
      );
      expect(order).toEqual([
        "inspect",
        ...(initiallyRunning ? ["stop"] : []),
        ...(fresh ? ["fresh-child"] : ["publication", "plugins"]),
        "doctor",
        "restart-verify",
      ]);
      expect(
        mocks.stopService.mock.calls.filter(([params]) => params.phase === "prepare"),
      ).toHaveLength(initiallyRunning ? 1 : 0);
      expect(freshChild).toHaveBeenCalledTimes(fresh ? 1 : 0);
      expect(mocks.completeRuntime).toHaveBeenCalledTimes(fresh ? 0 : 1);
      expect(mocks.restartService).toHaveBeenCalledOnce();
    } finally {
      identity.restore();
    }
  },
);
