import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import source from "../all-things.tokens.json" with { type: "json" };
import { expandCustomMedia, length, themeCss } from "../src/css.ts";
import { below, contentVw, portrait, sizes } from "../src/layout.ts";
import {
  dimension,
  dimensionGroups,
  dimensions,
  type Fluid,
  measures,
  TokenFile,
  tokens,
  typeRoles,
} from "../src/tokens.ts";

describe("the layout tokens", () => {
  test("give every group lengths, and every length a description", () => {
    for (const group of dimensionGroups) {
      expect(dimensions(tokens, group).length).toBeGreaterThan(0);
      for (const token of dimensions(tokens, group)) {
        expect(token.px).toBeGreaterThan(0);
        expect(token.description.length).toBeGreaterThan(0);
      }
    }
    expect(measures(tokens).map((measure) => measure.name)).toEqual([
      "prose",
      "lead",
      "statement",
    ]);
  });

  test("keep the spacing scale on a 4px step", () => {
    for (const step of dimensions(tokens, "space")) {
      expect(step.px).toBe(Number(step.name) * 4);
    }
  });

  test("list the breakpoints from narrowest to widest, all below the page", () => {
    const widths = dimensions(tokens, "breakpoint").map(({ px }) => px);
    expect(widths).toEqual(widths.toSorted((a, b) => a - b));
    expect(Math.max(...widths)).toBeLessThan(
      dimensions(tokens, "layout").find(({ name }) => name === "page")?.px ?? 0,
    );
  });

  test("never let a fluid length shrink below its floor or past its size", () => {
    for (const group of dimensionGroups) {
      for (const { fluid, px } of dimensions(tokens, group)) {
        if (fluid !== undefined && "min" in fluid && fluid.min !== undefined) {
          expect(fluid.min.value).toBeLessThan(px);
        }
      }
    }
  });

  test("leave the ledger's content most of the grid", () => {
    const decode = Schema.decodeUnknownExit(TokenFile);
    const file = structuredClone(source);
    for (const labels of [6, 11, 12]) {
      file.$extensions["dev.allthings"].ledgerColumns = labels;
      expect(decode(file)._tag).toBe("Failure");
    }
    file.$extensions["dev.allthings"].ledgerColumns = 5;
    expect(decode(file)._tag).toBe("Success");
  });

  test("reject a fluid length with neither a viewport nor a container share", () => {
    const decode = Schema.decodeUnknownExit(TokenFile);
    const file = structuredClone(source);
    file.layout.margin.$extensions["dev.allthings"].fluid = {
      min: { value: 16, unit: "px" },
    } as never;
    expect(decode(file)._tag).toBe("Failure");
  });
});

describe("a length as CSS", () => {
  test("is its size, or the clamp or min that narrows it", () => {
    expect(length({ px: 24, fluid: undefined })).toBe("24px");
    expect(
      length({
        px: 64,
        fluid: { min: { value: 16, unit: "px" }, viewport: 4.5 },
      }),
    ).toBe("clamp(16px, 4.5vw, 64px)");
    expect(length({ px: 72, fluid: { viewport: 12 } })).toBe("min(72px, 12vw)");
    expect(length({ px: 112, fluid: { container: 15.5 } })).toBe(
      "min(112px, 15.5cqi)",
    );
  });
});

describe("the theme's layout", () => {
  const css = themeCss(tokens);

  test("declares every length once, on :root", () => {
    for (const group of dimensionGroups.filter(
      (name) => name !== "breakpoint",
    )) {
      for (const token of dimensions(tokens, group)) {
        const name = `--at-${group.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}-${token.name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: `;
        expect(css.split(name)).toHaveLength(2);
      }
    }
    expect(css).toContain("--at-layout-margin: clamp(16px, 4.5vw, 64px);");
    expect(css).toContain("--at-measure-prose: 68ch;");
    expect(css).toContain("--at-ledger-label: 3;");
    expect(css).toContain("--at-ledger-content: 9;");
  });

  test("sizes each type role through its own custom property", () => {
    for (const role of typeRoles(tokens)) {
      const kebab = role.name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      expect(css).toContain(
        `.at-type-${kebab} {\n  font-family: var(--at-font-${role.family});\n  font-size: var(--at-type-${kebab}-size);`,
      );
    }
    expect(css).toContain("--at-type-lead-size: clamp(22px, 3vw, 30px);");
    expect(css).toContain("--at-type-body-size: clamp(18px, 2vw, 20px);");
  });

  test("names each breakpoint as a custom media query", () => {
    for (const { name, px } of dimensions(tokens, "breakpoint")) {
      expect(css).toContain(
        `@custom-media --at-below-${name} (max-width: ${px - 0.02}px);`,
      );
    }
  });
});

describe("custom media queries", () => {
  test("expand where @media names them, and their definitions go", () => {
    const css = expandCustomMedia(
      [
        "@custom-media --at-below-l (max-width: 767.98px);",
        "@media (--at-below-l) {",
        "  .a {",
        "    display: none;",
        "  }",
        "}",
        "@media (prefers-reduced-motion: reduce) and (--at-below-l) {}",
      ].join("\n"),
    );
    expect(css).not.toContain("@custom-media");
    expect(css).toContain("@media (max-width: 767.98px) {");
    expect(css).toContain(
      "@media (prefers-reduced-motion: reduce) and (max-width: 767.98px) {}",
    );
  });

  test("fail on a name nobody defined", () => {
    expect(() => expandCustomMedia("@media (--at-below-q) {}")).toThrow(
      "No custom media --at-below-q",
    );
  });

  test("leave the theme with none unexpanded", () => {
    const css = expandCustomMedia(themeCss(tokens));
    expect(css).not.toMatch(/@custom-media|@media[^{]*\(--/);
  });
});

describe("image sizes from the layout", () => {
  test("follow the stylesheet's breakpoints", () => {
    expect(below("l")).toBe("(max-width: 767.98px)");
  });

  test("give a share of the grid's columns as the margins narrow, and at its widest", () => {
    // The ledger's photos: a third of 9 of 12 columns, 12px apart; half the
    // page below the large breakpoint.
    expect(contentVw).toBe(91);
    expect(
      sizes(
        { span: 9, parts: 3, gap: 12 },
        { below: "l", span: 12, parts: 2, gap: 12 },
      ),
    ).toBe(
      "(max-width: 767.98px) calc(45.5vw - 6px), (max-width: 1439.98px) calc(22.75vw - 10px), 318px",
    );
  });

  test("give portraits their token sizes", () => {
    expect(portrait).toEqual({ xs: 36, s: 44, m: 72, l: 96, xl: 168 });
  });
});

describe("optical insets", () => {
  const css = themeCss(tokens);

  test("pull every role's letters back by its face's measured bearing", () => {
    for (const role of typeRoles(tokens)) {
      const kebab = role.name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      expect(role.inset).toBeGreaterThan(0);
      expect(role.inset).toBeLessThan(0.1);
      expect(css).toContain(`--at-type-${kebab}-inset: -${role.inset}em;`);
      expect(css).toContain(`text-indent: var(--at-type-${kebab}-inset);`);
    }
  });
});

/**
 * The size a length set with `fluid` comes to in a window `width` px wide,
 * as length() writes it; null for one that follows its container instead.
 */
function sizeAt(
  largest: number,
  fluid: Fluid | undefined,
  width: number,
): number | null {
  if (fluid === undefined) return largest;
  if ("container" in fluid) return null;
  const share = (fluid.viewport * width) / 100;
  return Math.max(fluid.min?.value ?? 0, Math.min(share, largest));
}

interface Display {
  readonly mmPerPx: number;
  readonly distanceMm: number;
}

/**
 * The visual angle, in degrees, that `px` CSS pixels make on a display
 * whose CSS pixel is `mmPerPx` wide, read from `distanceMm` away.
 */
const degrees = (px: number, { mmPerPx, distanceMm }: Display) =>
  (Math.atan((px * mmPerPx) / distanceMm) * 180) / Math.PI;

/**
 * The display reading text is hardest to make big enough on: a 49-inch
 * 5120x1440 ultrawide at 1x (about 108.5 pixels per inch) read from about
 * 70 cm, whose CSS pixel subtends less of the eye than the CSS reference
 * pixel does. A window on it is easily 2500px wide.
 */
const ultrawide: Display = { mmPerPx: 0.2341, distanceMm: 700 };
const ultrawideWindow = 2515;

describe("reading sizes, at the accessibility framework's excellent bar", () => {
  // Legibility runs by x-height, as the eye's angle sees it. Readers with
  // normal sight read fluently from about 0.2 degrees of x-height (the
  // critical print size); the smallest text people read stays at 0.17.
  const role = (name: string) => {
    const found = typeRoles(tokens).find((each) => each.name === name);
    if (found === undefined) throw new Error(`No type role ${name}`);
    return found;
  };
  const roleSize = (name: string, width: number) =>
    sizeAt(role(name).size, role(name).fluid, width) ?? 0;
  const archivo = role("body").xHeight;

  test("set nothing people read under 16px, on any screen", () => {
    const narrowest = 320;
    const sizes = [
      ...typeRoles(tokens).map(
        (each) =>
          [each.name, sizeAt(each.size, each.fluid, narrowest)] as const,
      ),
      ...dimensions(tokens, "fontSize").map(
        (token) =>
          [token.name, sizeAt(token.px, token.fluid, narrowest)] as const,
      ),
    ];
    expect(sizes.length).toBeGreaterThan(15);
    expect(sizes.filter(([, size]) => size !== null && !(size >= 16))).toEqual(
      [],
    );
  });

  test("give body copy a 0.2 degree x-height on a 1x ultrawide", () => {
    const size = roleSize("body", ultrawideWindow);
    expect(size).toBeGreaterThanOrEqual(20);
    expect(degrees(size * archivo, ultrawide)).toBeGreaterThanOrEqual(0.2);
  });

  test("give meta, list places and small copy 0.17 degrees there", () => {
    const small = dimension(tokens, "fontSize", "small");
    const angles = [
      ["meta", roleSize("meta", ultrawideWindow) * role("meta").xHeight],
      [
        "listPlace",
        roleSize("listPlace", ultrawideWindow) * role("listPlace").xHeight,
      ],
      [
        "small",
        (sizeAt(small.px, small.fluid, ultrawideWindow) ?? 0) * archivo,
      ],
    ].map(([name, xHeight]) => [name, degrees(Number(xHeight), ultrawide)]);
    expect(angles.filter(([, angle]) => !(Number(angle) >= 0.17))).toEqual([]);
  });

  test("measure each role's x-height from its face", () => {
    for (const each of typeRoles(tokens)) {
      expect(each.xHeight).toBeGreaterThan(0.5);
      expect(each.xHeight).toBeLessThan(0.56);
    }
    expect(role("meta").xHeight).not.toBe(archivo);
  });

  test("find text under its bar", () => {
    // 18px body, as the site had it, is 0.181 degrees there, and 14px meta 0.143.
    expect(degrees(18 * archivo, ultrawide)).toBeLessThan(0.2);
    expect(degrees(14 * role("meta").xHeight, ultrawide)).toBeLessThan(0.17);
    const body = { min: { value: 18, unit: "px" }, viewport: 2 } as const;
    expect(sizeAt(20, body, 390)).toBe(18);
    expect(sizeAt(20, body, 2515)).toBe(20);
    expect(sizeAt(72, { viewport: 12 }, 320)).toBe(38.4);
    expect(sizeAt(112, { container: 15.5 }, 320)).toBeNull();
  });
});
