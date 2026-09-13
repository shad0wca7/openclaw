import { safeParseJson, stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const UPDATE_DEV_TARGET_REF_ENV = "OPENCLAW_UPDATE_DEV_TARGET_REF";
export const UPDATE_DEV_BRANCH_ENV = "OPENCLAW_UPDATE_DEV_BRANCH";

/** An explicit branch must be a literal local branch, never a revision expression. */
export function isValidDevUpdateBranch(branch: string): boolean {
  return (
    branch.length > 0 &&
    branch !== "HEAD" &&
    branch !== "@" &&
    !branch.startsWith("-") &&
    !branch.startsWith("refs/") &&
    !/[\s~^:?*[\]\\]/u.test(branch) &&
    Array.from(branch).every((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f) &&
    !branch.includes("..") &&
    !branch.includes("@{") &&
    !branch.endsWith(".") &&
    branch
      .split("/")
      .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}

export function isDevUpdateBranchSelectionValid(
  selection: { devBranch?: string; devTarget?: DevUpdateTarget },
  channel: string,
  currentBranch: string | null,
): boolean {
  return (
    selection.devBranch === undefined ||
    (channel === "dev" &&
      !selection.devTarget &&
      isValidDevUpdateBranch(selection.devBranch) &&
      currentBranch === selection.devBranch)
  );
}

export function readDevUpdateBranch(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const branch = env[UPDATE_DEV_BRANCH_ENV];
  if (branch === undefined) {
    return undefined;
  }
  if (!isValidDevUpdateBranch(branch)) {
    throw new Error(`Invalid ${UPDATE_DEV_BRANCH_ENV}; expected a literal local Git branch name.`);
  }
  if (env[UPDATE_DEV_TARGET_REF_ENV]?.trim()) {
    throw new Error(
      `${UPDATE_DEV_BRANCH_ENV} cannot be combined with ${UPDATE_DEV_TARGET_REF_ENV}.`,
    );
  }
  return branch;
}

const TRACKED_DEV_TARGET_PREFIX = "openclaw-dev-target:v1:";
const MAX_TRACKED_DEV_TARGET_PAYLOAD_LENGTH = 4096;

export type DevUpdateTarget =
  | { mode: "detached"; ref: string }
  | { mode: "tracked"; upstreamRef: string; upstreamSha: string };

export type TrackedDevUpdateTarget = Extract<DevUpdateTarget, { mode: "tracked" }>;

type DevUpdateTargetEnvParseResult =
  | { status: "absent" }
  | { status: "valid"; target: DevUpdateTarget }
  | { status: "invalid" };

function isValidTargetPart(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/\s/u.test(value) &&
    Array.from(value).every((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
  );
}

function parseTrackedTarget(payload: string): TrackedDevUpdateTarget | undefined {
  if (
    payload.length === 0 ||
    payload.length > MAX_TRACKED_DEV_TARGET_PAYLOAD_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(payload)
  ) {
    return undefined;
  }
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8");
    if (Buffer.from(json, "utf8").toString("base64url") !== payload) {
      return undefined;
    }
    const decoded = safeParseJson(json);
    if (
      !isRecord(decoded) ||
      Object.keys(decoded).length !== 2 ||
      !("upstreamRef" in decoded) ||
      !("upstreamSha" in decoded)
    ) {
      return undefined;
    }
    const { upstreamRef, upstreamSha } = decoded;
    if (!isValidTargetPart(upstreamRef) || !isValidTargetPart(upstreamSha)) {
      return undefined;
    }
    return { mode: "tracked", upstreamRef, upstreamSha };
  } catch {
    return undefined;
  }
}

export function resolveDevUpdateTargetRevision(target: DevUpdateTarget): string {
  return target.mode === "tracked" ? target.upstreamSha : target.ref;
}

export function devUpdateTargetFromGitTarget(
  target: Pick<TrackedDevUpdateTarget, "upstreamRef" | "upstreamSha">,
): TrackedDevUpdateTarget {
  return {
    mode: "tracked",
    upstreamRef: target.upstreamRef,
    upstreamSha: target.upstreamSha,
  };
}

export function parseDevUpdateTargetEnv(env: NodeJS.ProcessEnv): DevUpdateTargetEnvParseResult {
  const value = env[UPDATE_DEV_TARGET_REF_ENV]?.trim();
  if (!value) {
    return { status: "absent" };
  }
  if (value.startsWith(TRACKED_DEV_TARGET_PREFIX)) {
    const target = parseTrackedTarget(value.slice(TRACKED_DEV_TARGET_PREFIX.length));
    return target ? { status: "valid", target } : { status: "invalid" };
  }
  if (value.includes(":")) {
    return { status: "invalid" };
  }
  return isValidTargetPart(value)
    ? { status: "valid", target: { mode: "detached", ref: value } }
    : { status: "invalid" };
}

export function applyDevUpdateTargetEnv(
  env: NodeJS.ProcessEnv,
  target: DevUpdateTarget,
): NodeJS.ProcessEnv {
  // Preserve the one-env handoff and shipped plain-ref contract; the namespaced
  // tracked encoding cannot be silently reinterpreted as a Git ref.
  const value =
    target.mode === "tracked"
      ? `${TRACKED_DEV_TARGET_PREFIX}${Buffer.from(
          stableStringify({
            upstreamRef: target.upstreamRef,
            upstreamSha: target.upstreamSha,
          }),
          "utf8",
        ).toString("base64url")}`
      : target.ref;
  return { ...env, [UPDATE_DEV_TARGET_REF_ENV]: value };
}
