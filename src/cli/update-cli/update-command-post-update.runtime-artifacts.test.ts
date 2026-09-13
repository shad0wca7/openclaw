import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  createManagedServiceIdentityFixture,
  finishSuccessfulPackageSwitch,
  managedServiceState,
  successfulPluginUpdate,
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

it("parks once and verifies a runtime-only repair when current plugin packages are skipped", async () => {
  vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  const identity = createManagedServiceIdentityFixture(tempDirs.make("current-runtime-repair-"));
  const order: string[] = [];
  let running = true;
  const verdict = {
    kind: "owned" as const,
    root: "/tmp/openclaw-update",
    fingerprint: "sealed",
    refreshDefinition: false,
  };
  mocks.readServiceState.mockResolvedValue(managedServiceState(process.env));
  mocks.stopService.mockImplementation(async () => {
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
      { restartEnvironment: process.env },
      {
        coreAlreadyCurrent: true,
        preManagedServiceStop: { running: true, stopped: false, serviceUpdateVerdict: verdict },
        result: {
          status: "skipped",
          reason: "already-current",
          mode: "git",
          root: "/tmp/openclaw-update",
          steps: [],
          durationMs: 1,
        },
      },
    );
    expect(order).toEqual(["stop", "publication", "plugins", "doctor", "restart-verify"]);
    expect(mocks.stopService).toHaveBeenCalledOnce();
    expect(mocks.restartService).toHaveBeenCalledOnce();
  } finally {
    identity.restore();
  }
});
