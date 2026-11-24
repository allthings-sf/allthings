import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
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

describe("the installer", () => {
  const platform = `bun-${process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
  const asset = `allthings-${platform}`;
  const binary = '#!/bin/sh\necho "allthings $*"\n';
  const sha256 = (text: string) =>
    new Bun.CryptoHasher("sha256").update(text).digest("hex");
  /** What install.bash needs besides curl, the hash tools aside. */
  const tools = [
    "uname",
    "tr",
    "grep",
    "cut",
    "mkdir",
    "mktemp",
    "rm",
    "chmod",
    "mv",
    "ln",
    "awk",
    "cp",
    "cat",
  ];

  /**
   * Runs cli/install.bash for release 9.9.9 against a curl that serves
   * `files` as that release's assets (and fails, as curl -f does, for any
   * other), with only `hashes` of sha256sum and shasum on the PATH.
   */
  const install = async (
    files: Record<string, string>,
    hashes: ReadonlyArray<string> = ["sha256sum", "shasum"],
  ) => {
    const fake = await mkdtemp(join(tmpdir(), "allthings-installer-"));
    try {
      for (const [name, content] of Object.entries(files)) {
        await Bun.write(join(fake, "release/9.9.9", name), content);
      }
      await Bun.write(
        join(fake, "bin/curl"),
        [
          "#!/bin/sh",
          'out=""; url=""',
          "while [ $# -gt 0 ]; do",
          '  case "$1" in -o) out=$2; shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac',
          "done",
          `file="${join(fake, "release")}/\${url##*/releases/download/}"`,
          '[ -f "$file" ] || exit 22',
          'if [ -n "$out" ]; then cp "$file" "$out"; else cat "$file"; fi',
          "",
        ].join("\n"),
      );
      await chmod(join(fake, "bin/curl"), 0o755);
      for (const tool of [...tools, ...hashes]) {
        const path = Bun.which(tool);
        if (path !== null) await symlink(path, join(fake, "bin", tool));
      }
      const home = join(fake, "home");
      const bash = Bun.which("bash");
      if (bash === null) throw new Error("no bash on the PATH");
      const result = Bun.spawnSync([bash, "cli/install.bash"], {
        cwd: new URL("../..", import.meta.url).pathname,
        env: {
          PATH: join(fake, "bin"),
          HOME: fake,
          ALLTHINGS_HOME: home,
          ALLTHINGS_VERSION: "9.9.9",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const installed = Bun.file(join(home, "bin/allthings"));
      return {
        code: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
        installed: (await installed.exists()) ? await installed.text() : null,
        left: await readdir(join(home, "bin")).catch(() => []),
      };
    } finally {
      await rm(fake, { recursive: true, force: true });
    }
  };
  const sums = (hash: string, name = asset) =>
    `${sha256("other")}  allthings-bun-windows-x64.exe\n${hash}  ${name}\n`;

  test("installs a binary whose SHA-256 is the release's SHA256SUMS line for it", async () => {
    const run = await install({
      [asset]: binary,
      SHA256SUMS: sums(sha256(binary)),
    });
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.installed).toBe(binary);
    expect(run.left.toSorted((a, b) => a.localeCompare(b))).toEqual([
      "allthings",
      "atw",
    ]);
    expect(run.stdout).toContain("Installed allthings 9.9.9");
  });

  test("checks with shasum where there's no sha256sum", async () => {
    if (Bun.which("shasum") === null) return;
    const good = await install(
      { [asset]: binary, SHA256SUMS: sums(sha256(binary)) },
      ["shasum"],
    );
    expect(good.code).toBe(0);
    expect(good.installed).toBe(binary);
    const bad = await install(
      { [asset]: binary, SHA256SUMS: sums(sha256("tampered")) },
      ["shasum"],
    );
    expect(bad.code).toBe(1);
    expect(bad.installed).toBeNull();
  });

  test("installs nothing when the binary doesn't match", async () => {
    const run = await install({
      [asset]: binary,
      SHA256SUMS: sums(sha256("a different binary")),
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      `${asset} from release 9.9.9 doesn't match its SHA256SUMS checksum. Nothing was installed.`,
    );
    expect(run.installed).toBeNull();
    expect(run.left).toEqual([]);
  });

  test("installs nothing from a release without SHA256SUMS, or without a line for this binary", async () => {
    const none = await install({ [asset]: binary });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain(
      "Release 9.9.9 publishes no SHA256SUMS, so its binary can't be checked. Nothing was installed.",
    );
    expect(none.installed).toBeNull();
    expect(none.left).toEqual([]);

    const missing = await install({
      [asset]: binary,
      SHA256SUMS: sums(sha256(binary), "allthings-bun-linux-riscv"),
    });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(
      `Release 9.9.9's SHA256SUMS has no checksum for ${asset}. Nothing was installed.`,
    );
    expect(missing.installed).toBeNull();
  });

  test("installs nothing when it has no tool to check with", async () => {
    const run = await install(
      { [asset]: binary, SHA256SUMS: sums(sha256(binary)) },
      [],
    );
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(
      "Found neither sha256sum nor shasum to check the binary with. Nothing was installed.",
    );
    expect(run.installed).toBeNull();
  });
});
