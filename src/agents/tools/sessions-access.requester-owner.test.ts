import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionToolRequesterAgentId } from "./sessions-access.js";

describe("detached session-tool requester ownership", () => {
  const explicitConfig: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "main" } },
      entries: { main: {}, hq: {} },
    },
  };

  it("maps an unknown host runtime label to the ambient system owner", () => {
    expect(
      resolveSessionToolRequesterAgentId({
        cfg: explicitConfig,
        effectiveRequesterKey: "main",
        requesterAgentId: "codex",
      }),
    ).toBe("main");
  });

  it("preserves a configured requester agent", () => {
    expect(
      resolveSessionToolRequesterAgentId({
        cfg: explicitConfig,
        effectiveRequesterKey: "main",
        requesterAgentId: "hq",
      }),
    ).toBe("hq");
  });

  it("preserves an agent-scoped requester key", () => {
    expect(
      resolveSessionToolRequesterAgentId({
        cfg: explicitConfig,
        effectiveRequesterKey: "agent:hq:main",
        requesterAgentId: "codex",
      }),
    ).toBe("hq");
  });

  it("preserves configured fixed-store ownership", () => {
    expect(
      resolveSessionToolRequesterAgentId({
        cfg: {
          ...explicitConfig,
          session: { store: "/tmp/openclaw-fixed-sessions.sqlite" },
          agents: {
            ...explicitConfig.agents,
            defaults: {
              ...explicitConfig.agents?.defaults,
              sessionStore: { agentId: "hq" },
            },
          },
        },
        effectiveRequesterKey: "main",
        requesterAgentId: "codex",
      }),
    ).toBe("hq");
  });
});
