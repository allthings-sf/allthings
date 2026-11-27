import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deploysOnlyFromMain,
  storeItem,
  throughPipe,
} from "../scripts/login-role.ts";

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
  const path = process.env["PATH"];
  const dirs: Array<string> = [];
  afterEach(async () => {
    process.env["PATH"] = path;
    delete process.env["FAKE_OP_LOG"];
    delete process.env["FAKE_OP_FAIL"];
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });
  /** Puts the fake op first on PATH; its log's path. */
  const withFakeOp = async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-op-"));
    dirs.push(dir);
    await writeFile(join(dir, "op"), fakeOp);
    await chmod(join(dir, "op"), 0o755);
    process.env["PATH"] = `${dir}:${path ?? ""}`;
    const log = join(dir, "log");
    await writeFile(log, "");
    process.env["FAKE_OP_LOG"] = log;
    return log;
  };
  /** The pipes' directories left in the temporary directory. */
  const leftovers = async () =>
    (await readdir(tmpdir())).filter((name) => name.startsWith("login-role-"));

  test("hands op the template through a named pipe, never a file, then archives the item it replaces", async () => {
    const log = await withFakeOp();
    const before = await leftovers();
    await storeItem({
      value: "a-new-password",
      item: "allthings test",
      vault: "allthings",
      notes: "made by the test",
    });
    const [create, ...deletes] = (await readFile(log, "utf8"))
      .trim()
      .split("\n");
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
    const log = await withFakeOp();
    process.env["FAKE_OP_FAIL"] = "1";
    const before = await leftovers();
    await expect(
      storeItem({
        value: "a-new-password",
        item: "allthings test",
        vault: "allthings",
        notes: "made by the test",
      }),
    ).rejects.toThrow("op item create failed: refused");
    expect((await readFile(log, "utf8")).includes("delete")).toBe(false);
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
});
