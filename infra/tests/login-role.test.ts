import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deploysOnlyFromMain, throughPipe } from "../scripts/login-role.ts";

describe("an environment a production credential may go in", () => {
  const mainOnly = {
    can_admins_bypass: false,
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true,
    },
  };
  const main = { branch_policies: [{ name: "main", type: "branch" }] };

  test("deploys from main alone, admins included", () => {
    expect(deploysOnlyFromMain(mainOnly, main)).toBe(true);
    expect(
      deploysOnlyFromMain(mainOnly, { branch_policies: [{ name: "main" }] }),
    ).toBe(true);
  });

  test("isn't one any branch may use", () => {
    expect(
      deploysOnlyFromMain(
        { can_admins_bypass: false, deployment_branch_policy: null },
        main,
      ),
    ).toBe(false);
    expect(
      deploysOnlyFromMain(
        {
          can_admins_bypass: false,
          deployment_branch_policy: {
            protected_branches: true,
            custom_branch_policies: false,
          },
        },
        { branch_policies: [] },
      ),
    ).toBe(false);
  });

  test("isn't one an admin may bypass", () => {
    expect(
      deploysOnlyFromMain({ ...mainOnly, can_admins_bypass: true }, main),
    ).toBe(false);
    expect(
      deploysOnlyFromMain(
        { deployment_branch_policy: mainOnly.deployment_branch_policy },
        main,
      ),
    ).toBe(false);
  });

  test("isn't one other branches or tags may use too", () => {
    expect(
      deploysOnlyFromMain(mainOnly, {
        branch_policies: [{ name: "main" }, { name: "release/*" }],
      }),
    ).toBe(false);
    expect(
      deploysOnlyFromMain(mainOnly, { branch_policies: [{ name: "*" }] }),
    ).toBe(false);
    expect(
      deploysOnlyFromMain(mainOnly, {
        branch_policies: [{ name: "main", type: "tag" }],
      }),
    ).toBe(false);
    expect(deploysOnlyFromMain(mainOnly, { branch_policies: [] })).toBe(false);
  });
});

/**
 * A fake `op` on PATH: it lists one item the new one replaces, gives an API
 * Credential template, and logs what `item create --template` reads from
 * its path (a named pipe or a file) and each `item delete`.
 */
const fakeOp = `#!/usr/bin/env bash
case "$1 $2" in
  "item list") echo '[{"id":"old","title":"allthings test"},{"id":"kept","title":"something else"}]' ;;
  "item template") echo '{"title":"","category":"API_CREDENTIAL","fields":[{"id":"credential","value":""},{"id":"notesPlain","value":""}]}' ;;
  "item create")
    path="$6"
    if [ -p "$path" ]; then kind=pipe; elif [ -f "$path" ]; then kind=file; else kind=missing; fi
    printf 'create %s %s\\n' "$kind" "$(cat "$path")" >> "$FAKE_OP_LOG"
    [ -z "$FAKE_OP_FAIL" ] || { echo "refused" >&2; exit 1; } ;;
  "item delete") printf 'delete %s\\n' "$3" >> "$FAKE_OP_LOG" ;;
esac
`;

describe("storing a credential in 1Password", () => {
  const dirs: Array<string> = [];
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });
  /**
   * `storeItem` in a Bun of its own, with the fake op first on its PATH (a
   * process looks commands up on the PATH it started with), and `fail` set
   * to make the fake refuse the create: its exit code, stderr and op's log.
   */
  const store = async (fail = false) => {
    const dir = await mkdtemp(join(tmpdir(), "fake-op-"));
    dirs.push(dir);
    await writeFile(join(dir, "op"), fakeOp);
    await chmod(join(dir, "op"), 0o755);
    const log = join(dir, "log");
    await writeFile(log, "");
    const script = fileURLToPath(
      new URL("../scripts/login-role.ts", import.meta.url),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { storeItem } from ${JSON.stringify(script)};
        await storeItem({ value: "a-new-password", item: "allthings test", vault: "allthings", notes: "made by the test" });`,
      ],
      {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env["PATH"] ?? ""}`,
          FAKE_OP_LOG: log,
          ...(fail ? { FAKE_OP_FAIL: "1" } : {}),
        },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    return { code, stderr, log: await readFile(log, "utf8") };
  };
  /** The pipes' directories left in the temporary directory. */
  const leftovers = async () =>
    (await readdir(tmpdir())).filter((name) => name.startsWith("login-role-"));

  test("hands op the template through a named pipe, never a file, then archives the item it replaces", async () => {
    const before = await leftovers();
    const { code, stderr, log } = await store();
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const [create, ...deletes] = log.trim().split("\n");
    expect(create?.startsWith("create pipe ")).toBe(true);
    const template = JSON.parse(create?.slice("create pipe ".length) ?? "") as {
      title: string;
      fields: Array<{ id: string; value: string }>;
    };
    expect(template.title).toBe("allthings test");
    expect(template.fields).toEqual([
      { id: "credential", value: "a-new-password" },
      { id: "notesPlain", value: "made by the test" },
    ]);
    expect(deletes).toEqual(["delete old"]);
    expect(await leftovers()).toEqual(before);
  });

  test("fails with op's refusal, archiving nothing, and leaves no pipe behind", async () => {
    const before = await leftovers();
    const { code, stderr, log } = await store(true);
    expect(code).not.toBe(0);
    expect(stderr).toContain("op item create failed: refused");
    expect(stderr).not.toContain("a-new-password");
    expect(log.includes("delete")).toBe(false);
    expect(await leftovers()).toEqual(before);
  });

  test("lets the pipe's writer go when nothing ever opens it to read", async () => {
    const before = await leftovers();
    expect(await throughPipe("never read", async () => "done")).toBe("done");
    await expect(
      throughPipe("never read", async () => {
        throw new Error("failed first");
      }),
    ).rejects.toThrow("failed first");
    expect(await leftovers()).toEqual(before);
  });

  test("lets the writer go when nothing reads text larger than the pipe holds", async () => {
    const before = await leftovers();
    const large = "x".repeat(200_000);
    expect(await throughPipe(large, async () => "done")).toBe("done");
    expect(
      await throughPipe(large, async (path) => {
        // A reader that reads only the start, then leaves.
        const handle = await open(path, "r");
        try {
          await handle.read(new Uint8Array(1_024), 0, 1_024, null);
        } finally {
          await handle.close();
        }
        return "read some";
      }),
    ).toBe("read some");
    expect(await leftovers()).toEqual(before);
  });
});
