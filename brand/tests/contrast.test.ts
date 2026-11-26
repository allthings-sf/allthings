import { describe, expect, test } from "bun:test";
import { apcaContrast, textFloor, wcagContrast } from "../src/contrast.ts";
import {
  contrastRequirements,
  dimension,
  modes,
  roleColor,
  tokens,
} from "../src/tokens.ts";

describe("the smallest text a contrast carries", () => {
  test("follows the APCA targets in foundations.md", () => {
    expect([90, 75, 74.9, 60, 59.9, 45, 44.9, 0].map(textFloor)).toEqual([
      "small",
      "small",
      "large",
      "large",
      "display",
      "display",
      undefined,
      undefined,
    ]);
    // Light text on dark grounds is negative; only the magnitude counts.
    expect(textFloor(-80)).toBe("small");
  });

  test("names sizes the tokens hold: 24px for Lc 60, 36px for Lc 45", () => {
    expect(dimension(tokens, "fontSize", "large").px).toBe(24);
    expect(dimension(tokens, "fontSize", "display").px).toBe(36);
  });

  test("keeps Glow on Night to display sizes, as the brand says", () => {
    expect(textFloor(apcaContrast("#FF6A3D", "#1B1729"))).toBe("display");
  });
});

// The accessibility framework's excellent bar: WCAG 2.2's enhanced contrast
// (SC 1.4.6, AAA) for everything people read, in both modes. That is 7:1,
// or 4.5:1 for text set only large (24px, or 18.66px and bold).
describe("enhanced contrast, for the excellent bar", () => {
  const pairs = contrastRequirements(tokens);

  test.each([...pairs])(
    "$use meets 7:1, or 4.5:1 where it is only large",
    ({ text, background, large }) => {
      expect(wcagContrast(text.hex, background.hex)).toBeGreaterThanOrEqual(
        large ? 4.5 : 7,
      );
    },
  );

  test("calls a pair large only where its APCA target or its use says it is", () => {
    for (const { minLc, large, use } of pairs) {
      // Below Lc 75, a color may only carry text at 24px and up.
      if (minLc < 75) expect([use, large]).toEqual([use, true]);
    }
    expect(pairs.filter(({ large }) => large).map(({ use }) => use)).toEqual([
      "Orange text at 24px and up",
      "The slash and display on Night",
      "Paper button labels",
      "Night button labels",
    ]);
  });

  test.each([...modes])(
    "holds %s's meta and links to 7:1 on its ground",
    (mode) => {
      const ground = roleColor(tokens, mode, "ground").hex;
      for (const role of ["text", "meta", "link"]) {
        expect(
          wcagContrast(roleColor(tokens, mode, role).hex, ground),
        ).toBeGreaterThanOrEqual(7);
      }
    },
  );

  test("finds the colors Paper had too faint", () => {
    // Meta, links and small orange text on Paper, before they were deepened.
    for (const old of ["#5E5A55", "#5B34D6", "#9A2B22"]) {
      expect(wcagContrast(old, "#F4F1EC")).toBeLessThan(7);
    }
  });
});
