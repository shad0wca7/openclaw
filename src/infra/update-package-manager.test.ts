// Covers package manager resolution for update build flows.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveUpdateBuildManager } from "./update-package-manager.js";

type PackageManagerCommandRunner = Parameters<typeof resolveUpdateBuildManager>[0];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function checkout(version: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-manager-test-"));
  roots.push(root);
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ packageManager: `pnpm@${version}+sha512.test` }),
  );
  return root;
}

describe("resolveUpdateBuildManager", () => {
  describe.each(["corepack", "npm"])("%s bootstrap deadlines", (installer) => {
    it.each([
      ["legacy caller", undefined, 5_000],
      ["unbounded update work", {}, undefined],
      ["explicit update deadline", { timeoutMs: 9_000 }, 9_000],
    ] as const)(
      "keeps pnpm bootstrap work separate from probes: %s",
      async (_label, work, expected) => {
        const root = await checkout("12.0.0");
        let installed = false;
        const runCommand: PackageManagerCommandRunner = async (argv, options) => {
          if (
            (installer === "npm" && argv[0] === "npm" && argv[1] === "install") ||
            (installer === "corepack" && argv[0] === "corepack" && argv[1] === "enable")
          ) {
            expect(options.timeoutMs).toBe(expected);
            installed = true;
            return { code: 0, stdout: "installed", stderr: "" };
          }
          expect(options.timeoutMs).toBe(5_000);
          if (
            (installer === "npm" && argv[0] === "corepack") ||
            (argv[0] === "pnpm" && !installed)
          ) {
            throw new Error("not installed");
          }
          return { code: 0, stdout: "12.0.0", stderr: "" };
        };
        const result = await resolveUpdateBuildManager(runCommand, root, 5_000, undefined, work);
        expect(result.kind).toBe("resolved");
        expect(installed).toBe(true);
        if (result.kind === "resolved") {
          await result.cleanup?.();
        }
      },
    );
  });

  it.each(["10.0.0", "11.15.1"])(
    "observes pnpm %s without letting its launcher rewrite the target lockfile",
    async (installedVersion) => {
      const version = "12.3.4";
      const root = await checkout(version);
      const lockfile = path.join(root, "pnpm-lock.yaml");
      const originalLockfile = "fixture target lockfile\n";
      await fs.writeFile(lockfile, originalLockfile);
      const baseEnv = {
        PATH: "/fixture/bin",
        pnpm_config_pm_on_fail: "download",
        PNPM_CONFIG_PM_ON_FAIL: "download",
        npm_config_manage_package_manager_versions: "true",
        NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: "true",
      };
      let prefix = "";
      const runCommand: PackageManagerCommandRunner = async (argv, options) => {
        const key = argv.join(" ");
        if (key === "pnpm --version") {
          const switchingDisabled = installedVersion.startsWith("10.")
            ? options.env?.npm_config_manage_package_manager_versions === "false"
            : options.env?.pnpm_config_pm_on_fail === "ignore";
          if (!switchingDisabled) {
            // Version-switching launchers mutate before reporting the requested version.
            await fs.writeFile(lockfile, "rewritten by launcher\n");
            return { stdout: version, stderr: "", code: 0 };
          }
          return { stdout: prefix ? version : installedVersion, stderr: "", code: 0 };
        }
        if (key === "corepack --version") {
          throw new Error("missing corepack");
        }
        expect(options.env).toEqual(baseEnv);
        if (key === "npm --version") {
          return { stdout: "11.0.0", stderr: "", code: 0 };
        }
        expect(argv.slice(0, 3)).toEqual(["npm", "install", "--prefix"]);
        expect(argv[4]).toBe(`pnpm@${version}`);
        prefix = argv[3]!;
        return { stdout: "installed", stderr: "", code: 0 };
      };
      const result = await resolveUpdateBuildManager(runCommand, root, 5000, baseEnv);
      expect(await fs.readFile(lockfile, "utf8")).toBe(originalLockfile);
      expect(prefix).not.toBe("");
      expect(result.kind).toBe("resolved");
      if (result.kind !== "resolved") {
        throw new Error(result.reason);
      }
      // Probe-only flags must not disable normal target-version handling during installation.
      expect(result.env?.pnpm_config_pm_on_fail).toBe("download");
      expect(result.env?.npm_config_manage_package_manager_versions).toBe("true");
      expect(baseEnv.pnpm_config_pm_on_fail).toBe("download");
      await result.cleanup?.();
    },
  );

  it.each(["11.22.0", "12.0.0"])(
    "bootstraps the target checkout's exact pnpm %s via npm instead of global pnpm 10",
    async (version) => {
      const root = await checkout(version);
      const calls: string[][] = [];
      let prefix = "";
      const runCommand: PackageManagerCommandRunner = async (argv, options) => {
        calls.push(argv);
        expect(options.cwd).toBe(root);
        const key = argv.join(" ");
        if (key === "pnpm --version") {
          const envPath = options.env?.PATH ?? options.env?.Path ?? "";
          if (
            prefix &&
            envPath.split(path.delimiter)[0] === path.join(prefix, "node_modules", ".bin")
          ) {
            return { stdout: version, stderr: "", code: 0 };
          }
          return { stdout: "10.0.0", stderr: "", code: 0 };
        }
        if (key === "corepack --version") {
          throw new Error("spawn corepack ENOENT");
        }
        if (key === "npm --version") {
          return { stdout: "10.0.0", stderr: "", code: 0 };
        }
        if (key.startsWith("npm install --prefix ")) {
          prefix = argv[3] ?? "";
          expect(argv[4]).toBe(`pnpm@${version}`);
          expect(JSON.parse(await fs.readFile(path.join(prefix, "package.json"), "utf8"))).toEqual({
            private: true,
            allowScripts: { [`pnpm@${version}`]: true },
          });
          return { stdout: "added pnpm", stderr: "", code: 0 };
        }
        throw new Error(`Unexpected command ${key}`);
      };
      const result = await resolveUpdateBuildManager(runCommand, root, 5000);
      expect(result.kind).toBe("resolved");
      if (result.kind !== "resolved") {
        throw new Error(result.reason);
      }
      expect(result.manager).toBe("pnpm");
      expect(calls).toContainEqual(["npm", "install", "--prefix", prefix, `pnpm@${version}`]);
      await expect(fs.stat(prefix)).resolves.toBeDefined();
      await result.cleanup?.();
      await expect(fs.stat(prefix)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["install", "verify"])("cleans failed pnpm bootstrap at %s", async (failure) => {
    const root = await checkout("12.0.0");
    let prefix = "";
    const runCommand: PackageManagerCommandRunner = async (argv) => {
      const key = argv.join(" ");
      if (key === "pnpm --version" || key === "corepack --version") {
        throw new Error("missing tool");
      }
      if (key === "npm --version") {
        return { stdout: "10.0.0", stderr: "", code: 0 };
      }
      prefix = argv[3] ?? "";
      return { stdout: "", stderr: "", code: failure === "install" ? 1 : 0 };
    };
    const result = await resolveUpdateBuildManager(runCommand, root, 5000);
    expect(result).toEqual({
      kind: "missing-required",
      preferred: "pnpm",
      reason: "pnpm-npm-bootstrap-failed",
    });
    await expect(fs.stat(prefix)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
