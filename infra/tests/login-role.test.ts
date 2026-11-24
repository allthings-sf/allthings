import { describe, expect, test } from "bun:test";
import { deploysOnlyFromMain } from "../scripts/login-role.ts";

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
