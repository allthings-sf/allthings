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
    expect(css).toContain("--at-type-body-size: clamp(18px, 2.2vw, 22px);");
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

describe("x-heights", () => {
  // What legibility thresholds are measured by, with the size: the angle a
  // lowercase x makes at the eye (brand/foundations.md, Typography).
  test("measure each role's from its face", () => {
    const roles = typeRoles(tokens);
    for (const role of roles) {
      expect([role.name, role.xHeight > 0.5 && role.xHeight < 0.56]).toEqual([
        role.name,
        true,
      ]);
    }
    const of = (name: string) =>
      roles.find((role) => role.name === name)?.xHeight;
    // Archivo's x at 400, and Geist Mono's, as Chromium's canvas metrics read them too.
    expect(of("body")).toBe(0.526);
    expect(of("meta")).toBe(0.532);
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
  /** The physical size of one CSS pixel, and the distance it's read from. */
  readonly mmPerPx: number;
  readonly distanceMm: number;
  /** A window on it, in CSS pixels wide. */
  readonly width: number;
}

/** The visual angle, in degrees, that `px` CSS pixels make on `display`. */
const degrees = (px: number, { mmPerPx, distanceMm }: Display) =>
  (Math.atan((px * mmPerPx) / distanceMm) * 180) / Math.PI;

/**
 * The displays a web page is read on, as the accessibility framework's
 * catalog declares them: the CSS reference pixel (1/96 inch at 28 inches),
 * a 14-inch laptop at 2x from 50 cm and a phone at 3x from 30 cm.
 */
const displays = {
  reference: { mmPerPx: 0.2646, distanceMm: 711, width: 1280 },
  laptop2x: { mmPerPx: 0.2, distanceMm: 500, width: 1512 },
  phone3x: { mmPerPx: 0.1657, distanceMm: 300, width: 390 },
} as const satisfies Record<string, Display>;

describe("reading sizes, at the accessibility framework's excellent bar", () => {
  // Legibility runs by x-height, as the angle it makes at the eye. ISO
  // 9241-3 prefers 20 arcminutes of character height for reading, about
  // 0.24 degrees of x-height and about the critical print size of a reader
  // near 60; its 16 arcminute minimum, about 0.19 degrees, is the least for
  // anything else people read.
  const bars = { body: 0.24, meta: 0.19 };
  const role = (name: string) => {
    const found = typeRoles(tokens).find((each) => each.name === name);
    if (found === undefined) throw new Error(`No type role ${name}`);
    return found;
  };
  const small = dimension(tokens, "fontSize", "small");
  const readers = [
    [
      "body",
      role("body").size,
      role("body").fluid,
      role("body").xHeight,
      bars.body,
    ],
    [
      "meta",
      role("meta").size,
      role("meta").fluid,
      role("meta").xHeight,
      bars.meta,
    ],
    [
      "listPlace",
      role("listPlace").size,
      role("listPlace").fluid,
      role("listPlace").xHeight,
      bars.meta,
    ],
    // Small copy is set in Archivo, as body is.
    ["small", small.px, small.fluid, role("body").xHeight, bars.meta],
  ] as const;

  test("set nothing people read under 16px, on any screen", () => {
    const narrowest = 320;
    const readingSizes = [
      ...typeRoles(tokens).map(
        (each) =>
          [each.name, sizeAt(each.size, each.fluid, narrowest)] as const,
      ),
      ...dimensions(tokens, "fontSize").map(
        (token) =>
          [token.name, sizeAt(token.px, token.fluid, narrowest)] as const,
      ),
    ];
    expect(readingSizes.length).toBeGreaterThan(15);
    expect(
      readingSizes.filter(([, size]) => size !== null && !(size >= 16)),
    ).toEqual([]);
  });

  test.each(Object.entries(displays))(
    "clear body's 0.24 degrees and everything else's 0.19 on %s",
    (_, display) => {
      const short = readers.flatMap(([name, size, fluid, xHeight, bar]) => {
        const angle = degrees(
          (sizeAt(size, fluid, display.width) ?? 0) * xHeight,
          display,
        );
        return angle >= bar ? [] : [[name, Number(angle.toFixed(3)), bar]];
      });
      expect(short).toEqual([]);
    },
  );

  test("keep a simple date inside the date column", () => {
    // 2026.09.30 in meta is 6.6 em with its tracking.
    const date = 10 * (0.6 + 0.06) * role("meta").size;
    expect(dimension(tokens, "size", "dateColumn").px).toBeGreaterThan(date);
  });

  test("find text under its bar", () => {
    // As the site had them: 18px body and 14px meta made 0.19 and 0.16
    // degrees at the reference pixel.
    expect(degrees(18 * role("body").xHeight, displays.reference)).toBeLessThan(
      bars.body,
    );
    expect(degrees(14 * role("meta").xHeight, displays.reference)).toBeLessThan(
      bars.meta,
    );
    const body = { min: { value: 18, unit: "px" }, viewport: 2.2 } as const;
    expect(sizeAt(22, body, 390)).toBe(18);
    expect(sizeAt(22, body, 1000)).toBe(22);
    expect(sizeAt(72, { viewport: 12 }, 320)).toBe(38.4);
    expect(sizeAt(112, { container: 15.5 }, 320)).toBeNull();
  });
});
