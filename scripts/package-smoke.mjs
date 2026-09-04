import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const artifacts = join(root, ".artifacts");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const windowsShell = process.platform === "win32";
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });

const packed = spawnSync(pnpmCommand, ["pack", "--pack-destination", artifacts], {
  cwd: root,
  encoding: "utf8",
  stdio: "pipe",
  shell: windowsShell,
});
if (packed.status !== 0) throw new Error(packed.error?.message || packed.stderr || packed.stdout);
const tarball = (await readdir(artifacts)).find((name) => name.endsWith(".tgz"));
if (!tarball) throw new Error("pnpm pack did not produce a tarball");

const consumer = await mkdtemp(join(tmpdir(), "profilefleet-consumer-"));
try {
  await writeFile(join(consumer, "package.json"), JSON.stringify({ type: "module", private: true }));
  const installed = spawnSync(npmCommand, [
    "install",
    "--ignore-scripts",
    "--omit=optional",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--prefer-offline",
    join(artifacts, tarball),
    "react",
    "react-dom",
  ], {
    cwd: consumer,
    encoding: "utf8",
    stdio: "pipe",
    shell: windowsShell,
  });
  if (installed.status !== 0) throw new Error(installed.error?.message || installed.stderr || installed.stdout);
  await writeFile(join(consumer, "smoke.mjs"), `
    const client = await import("profilefleet/client");
    const server = await import("profilefleet/server");
    const react = await import("profilefleet/react");
    const testing = await import("profilefleet/testing");
    const adapter = await import("profilefleet/adapters/cloakbrowser");
    if (!client.ProfileFleetClient || !server.ProfileFleet || !react.ProfileFleetProvider ||
        !testing.FakeBrowserAdapter || !adapter.CloakBrowserAdapter) {
      throw new Error("A documented package subpath is missing its public export");
    }
  `);
  const smoke = spawnSync(process.execPath, [join(consumer, "smoke.mjs")], {
    cwd: consumer,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (smoke.status !== 0) throw new Error(smoke.stderr || smoke.stdout);
  console.log(`Package smoke passed: ${tarball}`);
} finally {
  await rm(consumer, { recursive: true, force: true });
}
