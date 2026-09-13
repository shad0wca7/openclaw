import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as preparedModelCatalog from "../../agents/prepared-model-catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

const handleCommandsMock = vi.hoisted(() => vi.fn());

vi.mock("./commands.runtime.js", () => ({
  handleCommands: (...args: unknown[]) => handleCommandsMock(...args),
}));

const { maybeResolveNativeSlashCommandFastReply } =
  await import("./get-reply-native-slash-fast-path.js");

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createTypingController(): TypingController {
  return {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: vi.fn(),
  };
}

describe("native slash commands with a pending live model switch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    vi.spyOn(preparedModelCatalog, "loadPreparedModelCatalogSnapshot").mockResolvedValue({
      entries: [],
      routeVariants: [],
    });
    handleCommandsMock.mockReset();
    handleCommandsMock.mockResolvedValue({ shouldContinue: true, reply: undefined });
  });

  it("validates thinking against the pending model instead of the stale live model", async () => {
    const storePath = path.join(tempDirs.make("openclaw-native-pending-model-"), "sessions.json");
    const sessionKey = "agent:main:telegram:123";
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: "pending-model-session",
        updatedAt: Date.now(),
        modelProvider: "zai",
        model: "glm-5.3",
        liveModelSwitchPending: true,
      },
    );

    const result = await maybeResolveNativeSlashCommandFastReply({
      ctx: buildTestCtx({
        Body: "/think xhigh",
        BodyForAgent: "/think xhigh",
        RawBody: "/think xhigh",
        CommandBody: "/think xhigh",
        CommandSource: "native",
        CommandAuthorized: true,
        Provider: "telegram",
        Surface: "telegram",
        GatewayClientScopes: ["operator.admin"],
        SessionKey: "telegram:slash:123",
        CommandTargetSessionKey: sessionKey,
        CommandTurn: {
          kind: "native",
          source: "native",
          authorized: true,
          commandName: "think",
          body: "/think xhigh",
        },
      }),
      cfg: markCompleteReplyConfig({
        session: { store: storePath },
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-sol" },
            models: {
              "openai/gpt-5.6-sol": {},
              "zai/glm-5.3": {},
            },
          },
        },
      } as OpenClawConfig),
      agentId: "main",
      agentDir: "/tmp/agent",
      agentCfg: undefined,
      commandAuthorized: true,
      defaultProvider: "openai",
      defaultModel: "gpt-5.6-sol",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      provider: "zai",
      model: "glm-5.3",
      workspaceDir: "/tmp/workspace",
      typing: createTypingController(),
    });

    expect(result).toMatchObject({
      handled: true,
      reply: { text: "Thinking level set to xhigh." },
    });
    expect(loadExactSessionEntry({ sessionKey, storePath })?.entry).toMatchObject({
      thinkingLevel: "xhigh",
    });
  });
});
