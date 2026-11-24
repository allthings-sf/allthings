/**
 * What site-reader.ts and site-sync.ts share: a login role created by the
 * database owner with SQL (never Neon's console or API, whose roles join
 * neon_superuser), a fresh password, and its connection string stored as a
 * secret of environments that deploy only from main, and in 1Password,
 * without ever being printed.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = "allthings-sf/allthings";

/** Runs a command with `input` on stdin; fails with its stderr, never its input. */
export async function run(
  command: ReadonlyArray<string>,
  input = "",
): Promise<string> {
  const child = Bun.spawn([...command], {
    stdin: new Response(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`${command.slice(0, 3).join(" ")} failed: ${err.trim()}`);
  return out;
}

/** A new password. base64url is only letters, digits, "-" and "_": safe inside a SQL literal. */
export const newPassword = (): string => randomBytes(24).toString("base64url");

/** What provisionLoginRole needs of a connection: Bun.SQL's `unsafe`, or a transaction's. */
export interface Statements {
  unsafe(query: string, values?: ReadonlyArray<unknown>): Promise<unknown>;
}

const rows = async <A>(
  sql: Statements,
  query: string,
  values: ReadonlyArray<unknown>,
): Promise<ReadonlyArray<A>> => (await sql.unsafe(query, values)) as A[];

/**
 * Leaves `role` a login role with `password` and nothing more, whether it is
 * new or not, run as the owner (in a transaction, so a refusal changes
 * nothing):
 *
 * - created with no attributes beyond LOGIN; an existing role loses
 *   CREATEDB, CREATEROLE and INHERIT. NOINHERIT: it never acts with another
 *   role's privileges automatically.
 * - every membership it holds is revoked, so it can't SET ROLE to one
 *   either.
 * - then checked: SUPERUSER, BYPASSRLS and REPLICATION, which only a
 *   superuser may change, must already be off, or it fails.
 *
 * Whether the role was created rather than reset.
 */
export async function provisionLoginRole(
  sql: Statements,
  role: string,
  password: string,
): Promise<boolean> {
  const existing = await rows(
    sql,
    "SELECT 1 FROM pg_roles WHERE rolname = $1",
    [role],
  );
  await sql.unsafe(
    existing.length > 0
      ? `ALTER ROLE ${role} WITH LOGIN NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${password}'`
      : `CREATE ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT PASSWORD '${password}'`,
  );
  const memberships = await rows<{ rolname: string }>(
    sql,
    `SELECT g.rolname FROM pg_auth_members m
       JOIN pg_roles g ON g.oid = m.roleid
       JOIN pg_roles u ON u.oid = m.member
     WHERE u.rolname = $1`,
    [role],
  );
  for (const { rolname } of memberships) {
    await sql.unsafe(`REVOKE "${rolname}" FROM ${role}`);
  }
  const [attributes] = await rows<Record<string, unknown>>(
    sql,
    `SELECT rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
       rolbypassrls, rolreplication,
       (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid)::int AS memberships
     FROM pg_roles r WHERE rolname = $1`,
    [role],
  );
  const expected = {
    rolcanlogin: true,
    rolsuper: false,
    rolinherit: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolbypassrls: false,
    rolreplication: false,
    memberships: 0,
  };
  for (const [name, value] of Object.entries(expected)) {
    if (attributes?.[name] !== value) {
      throw new Error(
        `${role} has ${name} = ${String(attributes?.[name])}, not ${String(value)}; only a superuser can change that`,
      );
    }
  }
  return existing.length === 0;
}
/** The owner's connection string for `role` instead, direct rather than pooled (Hyperdrive pools). */
export function connectionStringFor(
  owner: string,
  role: string,
  password: string,
): string {
  const url = new URL(owner);
  url.username = role;
  url.password = password;
  url.hostname = url.hostname.replace("-pooler", "");
  return url.toString();
}

/** What GitHub says of an environment and its deployment branch policies. */
export interface EnvironmentSettings {
  readonly can_admins_bypass?: boolean;
  readonly deployment_branch_policy?: {
    readonly protected_branches?: boolean;
    readonly custom_branch_policies?: boolean;
  } | null;
}
export interface BranchPolicies {
  readonly branch_policies: ReadonlyArray<{
    readonly name: string;
    readonly type?: string;
  }>;
}

/**
 * Whether an environment deploys only from main, admins included: one
 * branch policy, main, and no bypass. A job in it on any other branch, a
 * pull request's included, is refused before it starts, so its secrets
 * never reach that branch's code, as a repository secret's would.
 */
export const deploysOnlyFromMain = (
  settings: EnvironmentSettings,
  policies: BranchPolicies,
): boolean =>
  settings.can_admins_bypass === false &&
  settings.deployment_branch_policy?.custom_branch_policies === true &&
  policies.branch_policies.length === 1 &&
  policies.branch_policies[0]?.name === "main" &&
  (policies.branch_policies[0].type ?? "branch") === "branch";

/**
 * Fails unless every one of `environments` deploys only from main
 * ({@link deploysOnlyFromMain}). Each script runs it before it changes the
 * role's password, so a refusal changes nothing.
 */
export async function requireMainOnly(
  environments: ReadonlyArray<string>,
): Promise<void> {
  for (const environment of environments) {
    const path = `repos/${repo}/environments/${encodeURIComponent(environment)}`;
    const settings = JSON.parse(
      await run(["gh", "api", path]),
    ) as EnvironmentSettings;
    const policies = JSON.parse(
      await run(["gh", "api", `${path}/deployment-branch-policies`]),
    ) as BranchPolicies;
    if (!deploysOnlyFromMain(settings, policies)) {
      throw new Error(
        `The ${environment} environment must deploy only from main, with no admin bypass, before a production credential goes in it. Nothing was changed.`,
      );
    }
  }
}

/**
 * Writes `value` as the secret `secret` of each of `environments` (each
 * checked with {@link requireMainOnly} first; none keeps it in 1Password
 * alone), and of the repository too when `repository` is set (only while a
 * workflow still reads the repository's), then to a new 1Password item
 * `item` in `vault`, and only then
 * archives the items it replaces, so 1Password always holds a working value
 * (1Password's own API Credential template, passed as a file only this user
 * can read and removed right after: op ignores the values of a template
 * piped on stdin). The role's password has already changed when this runs,
 * so it tries every store, whatever fails before it, and then names each
 * one still holding the old value and says to rerun the script.
 */
export async function storeConnectionString(options: {
  value: string;
  secret: string;
  environments: ReadonlyArray<string>;
  repository?: boolean;
  item: string;
  vault: string;
  notes: string;
}): Promise<void> {
  const targets = [
    ...options.environments.map((environment) => ({
      flags: ["--env", environment],
      where: `the ${environment} environment`,
    })),
    ...(options.repository === true
      ? [{ flags: [], where: "the repository" }]
      : []),
  ];
  // Every store is tried: one that fails never keeps the others on the old
  // password, which no longer works.
  const stale: Array<{ readonly where: string; readonly cause: unknown }> = [];
  for (const target of targets) {
    try {
      await run(
        [
          "gh",
          "secret",
          "set",
          options.secret,
          "--repo",
          repo,
          ...target.flags,
        ],
        options.value,
      );
    } catch (cause) {
      stale.push({ where: `${options.secret} in ${target.where}`, cause });
    }
  }
  try {
    await storeItem(options);
  } catch (cause) {
    stale.push({ where: `1Password ("${options.item}")`, cause });
  }
  const first = stale[0];
  if (first !== undefined) {
    throw new Error(
      `The role's password has changed, but ${stale.map((store) => store.where).join(" and ")} may still hold the old one: ${first.cause instanceof Error ? first.cause.message : String(first.cause)}. Rerun this script once ${stale.length === 1 ? "it answers" : "they answer"}.`,
      { cause: first.cause },
    );
  }
}

/**
 * Stores `value` as the credential of a new 1Password item `item` in `vault`,
 * then archives the items it replaces, so 1Password always holds a working
 * value. 1Password's own API Credential template is passed as a file only
 * this user can read, removed right after: op ignores the values of a
 * template piped on stdin. The value is never an argument or printed.
 */
export async function storeItem(options: {
  value: string;
  item: string;
  vault: string;
  notes: string;
}): Promise<void> {
  const replaced = (
    JSON.parse(
      await run([
        "op",
        "item",
        "list",
        "--vault",
        options.vault,
        "--format",
        "json",
      ]),
    ) as Array<{ id: string; title: string }>
  ).filter((existing) => existing.title === options.item);
  const template = JSON.parse(
    await run(["op", "item", "template", "get", "API Credential"]),
  ) as { title?: string; fields: Array<{ id: string; value?: string }> };
  template.title = options.item;
  for (const field of template.fields) {
    if (field.id === "credential") field.value = options.value;
    if (field.id === "notesPlain") field.value = options.notes;
  }
  const dir = await mkdtemp(join(tmpdir(), "login-role-"));
  try {
    const file = join(dir, "item.json");
    await writeFile(file, JSON.stringify(template), { mode: 0o600 });
    await run([
      "op",
      "item",
      "create",
      "--vault",
      options.vault,
      "--template",
      file,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  for (const { id } of replaced) {
    await run([
      "op",
      "item",
      "delete",
      id,
      "--vault",
      options.vault,
      "--archive",
    ]);
  }
}
