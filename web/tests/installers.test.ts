import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installers } from "../scripts/build.ts";
import { cliCommands } from "../src/links.ts";

/**
 * The CLI's installers and their addresses. The site serves them at
 * allthings.dev (scripts/build.ts; pages.test.ts fetches them from the
 * Worker); the GitHub Pages copies in pages/ only run those, so the links
 * to Pages keep working until the organization's rename ends them.
 */

const origin = "https://allthings.dev";

const read = (path: string) =>
  Bun.file(new URL(`../../${path}`, import.meta.url)).text();

/** The `curl … | bash` lines a script runs. */
const curls = (script: string) =>
  script
    .split("\n")
    .filter((line) => line.startsWith("curl "))
    .map((line) => line.trim());

describe("the CLI's installers", () => {
  test("are /install.bash and /atw-install.bash, from cli/", () => {
    expect(installers).toEqual([
      ["install.bash", "cli/install.bash"],
      ["atw-install.bash", "cli/atw-install.bash"],
    ]);
  });

  test("are installed from allthings.dev, as the about page and the CLI's README say", async () => {
    expect(cliCommands.install).toBe(
      `curl -fsSL ${origin}/install.bash | bash`,
    );
    expect(await read("cli/install.bash")).toContain(
      `\n#   ${cliCommands.install}\n`,
    );
  });

  test("the old name's runs /install.bash", async () => {
    expect(curls(await read("cli/atw-install.bash"))).toEqual([
      cliCommands.install,
    ]);
  });

  test("on GitHub Pages, each runs the one of its name on allthings.dev, and nothing else", async () => {
    for (const [published] of installers) {
      expect(curls(await read(`pages/${published}`))).toEqual([
        `curl -fsSL ${origin}/${published} | bash`,
      ]);
    }
  });

  test("take the old name's ATW_VERSION, with a note on stderr, when ALLTHINGS_VERSION is unset", async () => {
    // A curl that fetches nothing, so the run ends at the download: what it
    // printed by then is the note, or not.
    const fake = await mkdtemp(join(tmpdir(), "allthings-installer-"));
    await Bun.write(join(fake, "bin/curl"), "#!/bin/sh\nexit 22\n");
    await chmod(join(fake, "bin/curl"), 0o755);
    const note =
      "ATW_VERSION is now ALLTHINGS_VERSION. The old name still works for now and goes away in a later release.";
    const run = (env: Record<string, string>) => {
      const result = Bun.spawnSync(["bash", "cli/install.bash"], {
        cwd: new URL("../..", import.meta.url).pathname,
        env: {
          PATH: `${join(fake, "bin")}:/usr/bin:/bin`,
          HOME: fake,
          ALLTHINGS_HOME: join(fake, "home"),
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: result.exitCode, stderr: result.stderr.toString() };
    };
    try {
      const old = run({ ATW_VERSION: "9.9.9" });
      expect(old.code).toBe(1);
      expect(old.stderr).toContain(`${note}\n`);
      expect(old.stderr).toContain("Release 9.9.9 has no binary");
      const both = run({ ATW_VERSION: "9.9.9", ALLTHINGS_VERSION: "9.9.8" });
      expect(both.code).toBe(1);
      expect(both.stderr).not.toContain(note);
      expect(both.stderr).toContain("Release 9.9.8 has no binary");
    } finally {
      await rm(fake, { recursive: true, force: true });
    }
  });

  test("verifies the selected asset before replacing or running the CLI", async () => {
    const temp = await mkdtemp(join(tmpdir(), "allthings-checksum-"));
    const binary = "#!/bin/sh\necho verified-cli\n";
    const digest = new Bun.CryptoHasher("sha256").update(binary).digest("hex");
    const curl = join(temp, "tools/curl");
    await Bun.write(
      curl,
      [
        "#!/usr/bin/env bash",
        'url="${!#}"',
        'case "$url" in',
        '  */releases/tags/*) printf "%s" "$METADATA" ;;',
        '  */SHA256SUMS) [[ -z "$METADATA" ]] || exit 22; printf "%s  %s\\n" "$DIGEST" "$ASSET" ;;',
        '  */allthings-bun-*) printf "%s" "$BINARY" > "$3" ;;',
        "  *) exit 22 ;;",
        "esac",
      ].join("\n"),
    );
    await chmod(curl, 0o755);
    const os = process.platform;
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const asset = `allthings-bun-${os}-${arch}`;
    const installed = join(temp, "bin/allthings");
    const run = (checksum: string, filename = asset, metadata = "") =>
      Bun.spawnSync(["bash", "cli/install.bash"], {
        cwd: new URL("../..", import.meta.url).pathname,
        env: {
          PATH: `${join(temp, "tools")}:/usr/bin:/bin`,
          HOME: temp,
          ALLTHINGS_HOME: temp,
          ALLTHINGS_VERSION: "2.8.1",
          BINARY: binary,
          ASSET: filename,
          DIGEST: checksum,
          METADATA: metadata,
        },
      });
    try {
      await Bun.write(installed, "existing install");
      const metadata = (checksum: string | null) =>
        JSON.stringify({ assets: [{ name: asset, digest: checksum }] });
      for (const result of [
        run("0".repeat(64)),
        run(digest, "other"),
        run("", asset, metadata(null)),
      ]) {
        expect(result.exitCode).toBe(1);
        expect(result.stdout.toString()).not.toContain("verified-cli");
      }
      expect(await Bun.file(installed).text()).toBe("existing install");
      for (const verified of [
        run(digest),
        run("", asset, metadata(`sha256:${digest}`)),
      ]) {
        expect(verified.exitCode).toBe(0);
        expect(verified.stdout.toString()).toContain("verified-cli");
      }
      expect(await Bun.file(installed).text()).toBe(binary);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  test("are bash that parses", async () => {
    const scripts = [
      ...installers.map(([, source]) => source),
      ...installers.map(([published]) => `pages/${published}`),
    ];
    for (const script of scripts) {
      const check = Bun.spawnSync(["bash", "-n", script], {
        cwd: new URL("../..", import.meta.url).pathname,
        stderr: "pipe",
      });
      expect(`${script}: ${check.stderr.toString()}`).toBe(`${script}: `);
      expect(check.exitCode).toBe(0);
    }
  });
});
