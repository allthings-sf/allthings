import { describe, expect, test } from "bun:test";
import { themeCss } from "allthings-brand/src/css.ts";
import { tokens, typeRoles } from "allthings-brand/src/tokens.ts";

/**
 * The site's own rules color only through the theme's roles, whose
 * pairings the brand's tests hold to their APCA targets in both modes, and
 * size and space only through the layout tokens, so a one-off length, a
 * magic width or a breakpoint of a page's own fails the build. The home
 * lab's stylesheet, which only its pages load, is held to the same.
 */

const stylesheet = (name: string) =>
  Bun.file(new URL(`../src/styles/${name}`, import.meta.url)).text();
const site = await stylesheet("site.css");
const lab = await stylesheet("lab.css");
const depth = await stylesheet("depth.css");
const mcpApp = await stylesheet("mcp-app.css");
const theme = themeCss(tokens);

/**
 * Every stylesheet of the site's own rules, by name: the MCP App view's
 * (src/mcp/apps.ts), which agent hosts draw in their chats, among them.
 */
const stylesheets = [
  ["site.css", site],
  ["lab.css", lab],
  ["depth.css", depth],
  ["mcp-app.css", mcpApp],
] as const;

/** CSS Color 4's named colors, plus the keywords that also pick a color. */
const namedColors = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black
  blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse
  chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan
  darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta
  darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen
  darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink
  deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen
  fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey
  honeydew hotpink indianred indigo ivory khaki lavender lavenderblush
  lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow
  lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen
  lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime
  limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid
  mediumpurple mediumseagreen mediumslateblue mediumspringgreen
  mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin
  navajowhite navy oldlace olive olivedrab orange orangered orchid
  palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff
  peru pink plum powderblue purple rebeccapurple red rosybrown royalblue
  saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue
  slateblue slategray slategrey snow springgreen steelblue tan teal thistle
  tomato turquoise violet wheat white whitesmoke yellow yellowgreen
  transparent currentcolor accentcolor accentcolortext activetext buttonborder
  buttonface buttontext canvas canvastext field fieldtext graytext highlight
  highlighttext linktext mark marktext selecteditem selecteditemtext
  visitedtext`.split(/\s+/),
);

/** Each declaration's value, without comments, strings or custom properties. */
const declarationsOf = (css: string) =>
  [
    ...css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .matchAll(/(?:^|[{;])\s*(-?[a-z][a-z-]*)\s*:([^;{}]*)/gm),
  ].map(([, property = "", value = ""]) => ({ property, value }));

const siteDeclarations = declarationsOf(site);

test("site.css and lab.css are read declaration by declaration", () => {
  expect(siteDeclarations.length).toBeGreaterThan(100);
  expect(siteDeclarations).toContainEqual({
    property: "color",
    value: " var(--at-link)",
  });
  expect(declarationsOf(lab).length).toBeGreaterThan(100);
});

/** A stylesheet's rules: each one's selectors, and its last line-height, the one CSS applies. */
const leadingOf = (css: string) =>
  [
    ...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ].map(([, selector = "", body = ""]) => ({
    selectors: selector.split(",").map((part) => part.trim()),
    lineHeight: declarationsOf(`{${body}`)
      .findLast(({ property }) => property === "line-height")
      ?.value.trim(),
  }));

/** The element a selector styles: its last compound, after any combinator. */
const subjectOf = (selector: string) =>
  selector
    .trim()
    .split(/\s*[>+~]\s*|\s+/)
    .filter(Boolean)
    .at(-1) ?? "";

/** The selectors in `css` that set a line height on an element of `className`. */
const settingLeadingOn = (css: string, className: string) => {
  const ofClass = new RegExp(`\\.${className}(?![\\w-])`);
  return leadingOf(css).flatMap(({ selectors, lineHeight }) =>
    lineHeight === undefined
      ? []
      : selectors.filter((selector) => ofClass.test(subjectOf(selector))),
  );
};

test("site.css gives wrapped headings, buttons and talk rows room between lines", () => {
  // The accessibility framework's excellent bar: headings 1.1 to 1.3, body
  // 1.5 to 1.75. A talk's title, evening and parts run to two or three lines
  // and read as running text, so no rule styling them, their row or its list
  // sets a line height: they take the body's 1.55.
  const rules = leadingOf(site);
  const lineHeightOf = (selector: string) =>
    rules
      .filter(
        ({ selectors, lineHeight }) =>
          selectors.includes(selector) && lineHeight !== undefined,
      )
      .map(({ lineHeight }) => Number(lineHeight));
  expect(lineHeightOf("body")).toEqual([1.55]);
  for (const heading of [
    ".prose h2",
    ".organizers .person-name",
    ".person-page-name",
  ]) {
    const values = lineHeightOf(heading);
    expect([heading, values.length > 0]).toEqual([heading, true]);
    for (const value of values) {
      expect([heading, value >= 1.1 && value <= 1.3]).toEqual([heading, true]);
    }
  }
  const button = lineHeightOf(".button");
  expect(button.length).toBeGreaterThan(0);
  expect(button.every((value) => value >= 1.2)).toBe(true);
  for (const row of [
    "talks",
    "talk",
    "talk-title",
    "talk-evening",
    "talk-parts",
  ]) {
    expect([row, settingLeadingOn(site, row)]).toEqual([row, []]);
  }
});

test("finds a rule that sets a talk row's leading however it's selected", () => {
  const css = `.talks > .talk { line-height: 1; }
li a.talk:hover .talk-title { color: red; line-height: 1.55; line-height: 1.2; }
.talk-titles { line-height: 1; }
.talk .date { line-height: 1; }`;
  expect(settingLeadingOn(css, "talk")).toEqual([".talks > .talk"]);
  expect(settingLeadingOn(css, "talk-title")).toEqual([
    "li a.talk:hover .talk-title",
  ]);
  expect(leadingOf(css)[1]?.lineHeight).toBe("1.2");
});

/** Whether every selector in a list styles inline code, the one text that may shrink. */
const onlyInlineCode = (selector: string) =>
  selector.split(",").every((part) => /(?:^|\s)code$/.test(part.trim()));

describe.each(stylesheets)("%s", (sheet, css) => {
  const declarations = declarationsOf(css);

  test("names no color of its own", () => {
    for (const { property, value } of declarations) {
      const declaration = `${property}:${value}`;
      expect(declaration).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(declaration).not.toMatch(
        /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|device-cmyk)\(/i,
      );
      const words = value
        .replace(/var\([^)]*\)/g, "")
        .toLowerCase()
        .match(/[a-z][a-z-]*/g);
      for (const word of words ?? []) {
        expect(namedColors.has(word) ? declaration : word).toBe(word);
      }
    }
  });

  test("sets type only in the type tokens' sizes, and shrinks only inline code", () => {
    // The tokens hold every size people read to the excellent bar: nothing
    // under 16px, body at 0.24 degrees of x-height and meta at 0.19 on every
    // display a page is read on (brand/tests/layout.test.ts). A rule can only scale one up, or set
    // inline code in mono a tenth smaller than the text it sits in.
    const token = String.raw`var\(--at-(?:type-[a-z-]+-size|font-size-[a-z0-9-]+)\)`;
    const allowed = new RegExp(
      `^(?:${token}|calc\\(${token} \\* (?:[1-9][0-9]*(?:\\.[0-9]+)?)\\)|min\\(\\s*${token},\\s*calc\\(${token} \\* (?:[1-9][0-9]*(?:\\.[0-9]+)?)\\)\\s*\\)|inherit|1em)$`,
    );
    const rules = [
      ...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g),
    ].flatMap(([, selector = "", body = ""]) =>
      declarationsOf(`{${body}`)
        .filter(({ property }) => property === "font-size")
        .map(({ value }) => ({
          selector: selector.trim(),
          value: value.trim(),
        })),
    );
    expect(rules.length).toBeGreaterThan(0);
    const loose = rules.filter(
      ({ selector, value }) =>
        !allowed.test(value) &&
        !(value === "0.9em" && onlyInlineCode(selector)),
    );
    expect(loose).toEqual([]);
  });

  test("sets every button's label as large text, which its contrast is held to", () => {
    // Night's buttons are white on Bridge at 5.5:1, enough for WCAG's
    // enhanced contrast only for large text: 18.66px (14pt) and bold, or up.
    const listName = typeRoles(tokens).find(({ name }) => name === "listName");
    // 21px and heavy, as brand/foundations.md says: past 18.66px and bold.
    expect(listName?.size).toBe(21);
    const buttons = [
      ...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g),
    ]
      .map(([, selector = "", body = ""]) => ({
        selector: selector.trim(),
        rule: declarationsOf(`{${body}`),
      }))
      .filter(({ rule }) =>
        rule.some(
          ({ property, value }) =>
            property === "color" && value.trim() === "var(--at-button-text)",
        ),
      );
    // The site's pages and the MCP App view have buttons; the labs have none.
    if (sheet === "site.css" || sheet === "mcp-app.css") {
      expect(buttons.length).toBeGreaterThan(0);
    }
    for (const { selector, rule } of buttons) {
      const value = (name: string) =>
        rule.find(({ property }) => property === name)?.value.trim();
      expect([
        selector,
        value("font-size"),
        Number(value("font-weight")) >= 700,
      ]).toEqual([selector, "var(--at-type-list-name-size)", true]);
    }
  });

  test("lets only inline code shrink, selector by selector", () => {
    expect(onlyInlineCode("code")).toBe(true);
    expect(onlyInlineCode(".brief-body code")).toBe(true);
    expect(onlyInlineCode(".person-bio, code")).toBe(false);
    expect(onlyInlineCode("code.lede")).toBe(false);
  });

  test("uses only custom properties the theme defines", () => {
    const used = new Set(
      [...css.matchAll(/var\((--at-[a-z0-9-]+)\)/g)].map(([, name]) => name),
    );
    expect(used.size).toBeGreaterThan(5);
    for (const name of used) expect(theme).toContain(`${name}:`);
  });
});

/** A length: a number and a unit; `%` and `fr` are shares, not lengths. */
const lengths =
  /(?<![\w-])-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em|ex|ch|lh|rlh|vw|vh|vi|vb|vmin|vmax|[sld]v[whib]|cq[whib]|cqmin|cqmax|in|cm|mm|pt|pc|q)\b/gi;

/** The lengths in a value, outside the custom properties it reads. */
const lengthsIn = (value: string): ReadonlyArray<string> =>
  value.replace(/var\(--[a-z0-9-]+\)/g, "").match(lengths) ?? [];

/** The one length a page may write itself: a hairline, as `.visually-hidden` is. */
const hairline = "1px";

/** What may follow the type in em: its tracking, underline offset and size. */
const typeRelative = /^(?:letter-spacing|text-underline-offset|font-size)$/;

/** What sets a box's size, or a grid's tracks. */
const sizing =
  /^(?:(?:min-|max-)?(?:width|height|inline-size|block-size)|flex-basis|grid-(?:template|auto)-(?:columns|rows))$/;

/** A length in em, and not in rem. */
const em = /^-?(?:\d+(?:\.\d+)?|\.\d+)em$/;

/** The declarations' lengths that come from no token: all but a hairline and type-relative em. */
const looseLengths = (
  declarations: ReadonlyArray<{ property: string; value: string }>,
): ReadonlyArray<string> =>
  declarations.flatMap(({ property, value }) =>
    lengthsIn(value)
      .filter((length) => length !== hairline)
      .filter((length) => !(em.test(length) && typeRelative.test(property)))
      .map((length) => `${property}: ${length}`),
  );

/**
 * A margin made only of 0, auto and spacing tokens, which are positive: it
 * can't pull a box back over its neighbor, whatever arithmetic would do.
 */
const isTokenMargin = (value: string): boolean =>
  value
    .trim()
    .split(/\s+/)
    .every((part) => /^(?:0|auto|var\(--at-space-[0-9]+\))$/.test(part));

describe.each(stylesheets)("%s's lengths", (_, css) => {
  const declarations = declarationsOf(css);

  test("come from the layout tokens, but for a hairline and type-relative em", () => {
    expect(looseLengths(declarations)).toEqual([]);
  });

  test("are caught in rem, and in em outside the type", () => {
    expect(
      looseLengths([
        { property: "font-size", value: " 2rem" },
        { property: "margin", value: " 100em" },
        { property: "letter-spacing", value: " -0.03em" },
        { property: "border", value: " 1px solid var(--at-rule)" },
      ]),
    ).toEqual(["font-size: 2rem", "margin: 100em"]);
  });

  test("size boxes with no width of their own", () => {
    const magic = declarations.flatMap(({ property, value }) =>
      sizing.test(property)
        ? [
            ...value
              .replace(/var\(--[a-z0-9-]+\)/g, "")
              .matchAll(/(?<![\w-])\d*\.?\d+([a-z%]+)/gi),
          ]
            .map(([length = ""]) => length)
            .filter(
              (length) =>
                length !== hairline &&
                length !== "100%" &&
                !length.endsWith("fr"),
            )
            .map((length) => `${property}: ${length}`)
        : [],
    );
    expect(magic).toEqual([]);
  });

  test("never pull a box over its neighbor: margins are 0, auto or a token", () => {
    // Portraits side by side, never stacked: every host is always seen.
    const pulled = declarations.filter(
      ({ property, value }) =>
        property.startsWith("margin") && !isTokenMargin(value),
    );
    expect(pulled).toEqual([]);
  });

  test("tell a token margin from one that could pull back", () => {
    for (const value of [
      " 0",
      " 0 auto",
      " var(--at-space-1) 0 0",
      " auto 0",
    ]) {
      expect(isTokenMargin(value)).toBe(true);
    }
    for (const value of [
      " -4px",
      " calc(-1 * var(--at-space-2))",
      " calc(0px - 2px)",
      " calc(0px - var(--at-space-2))",
      " 0 -1em",
    ]) {
      expect(isTokenMargin(value)).toBe(false);
    }
  });

  test("define no custom properties of their own", () => {
    expect(css.match(/(?:^|[{;])\s*--[a-z0-9-]+\s*:/gm)).toBeNull();
  });

  test("break only at the tokens' breakpoints", () => {
    const preludes = [...css.matchAll(/@media([^{]*)\{/g)].map(
      ([, prelude = ""]) => prelude.trim(),
    );
    expect(preludes.length).toBeGreaterThan(2);
    for (const prelude of preludes) {
      for (const [, name] of prelude.matchAll(/\((--[a-z0-9-]+)\)/g)) {
        expect(theme).toContain(`@custom-media ${name} `);
      }
      expect(prelude.replace(/\(--[a-z0-9-]+\)/g, "")).not.toMatch(/\d/);
    }
  });
});

describe.each(stylesheets)("%s for reduced motion", (_, css) => {
  test("cuts every transition, which answers the pointer", () => {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const start = bare.indexOf("@media (prefers-reduced-motion: reduce)");
    const settled = [
      ...bare.slice(start).matchAll(/([^{}]+)\{\s*transition: none;\s*\}/g),
    ]
      .flatMap(([, selectors = ""]) => selectors.split(","))
      .map((selector) => selector.trim());
    const transitioned = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter(([, , body = ""]) =>
        /(?:^|;)\s*transition:(?!\s*none)/.test(body),
      )
      .flatMap(([, selector = ""]) => selector.trim().split(/,\s*/));
    if (transitioned.length > 0) expect(start).toBeGreaterThan(-1);
    for (const selector of transitioned) expect(settled).toContain(selector);
  });
});

describe("the pages", () => {
  test("set no inline style: every rule is in site.css", async () => {
    const styled: Array<string> = [];
    for await (const path of new Bun.Glob("src/**/*.{ts,tsx}").scan({
      cwd: new URL("..", import.meta.url).pathname,
    })) {
      const source = await Bun.file(
        new URL(`../${path}`, import.meta.url),
      ).text();
      if (/\sstyle=|[\s{,]style:\s|setAttribute\(\s*["']style/.test(source)) {
        styled.push(path);
      }
    }
    expect(styled).toEqual([]);
  });
});

/** A stylesheet's rules, selector by selector. */
const rulesOf = (css: string) =>
  [
    ...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ].map(([, selector = "", body = ""]) => ({
    selector: selector.trim(),
    body,
  }));

/** site.css's rules, selector by selector. */
const rules = rulesOf(site);

describe.each(stylesheets)("display type in %s", (name, css) => {
  const sheetRules = rulesOf(css);

  test("is pulled back to the box's edge by its face's inset", () => {
    // Archivo at 112% is the wordmark's and the lockups' face; at 75%, the
    // label's. Each rule that sets one sets its role's optical inset too.
    const unpulled = sheetRules
      .filter(({ body }) => /font-stretch: (?:112|75)%/.test(body))
      .filter(
        ({ body }) =>
          !/text-indent: var\(--at-type-(?:wordmark|event-lockup|label)-inset\);/.test(
            body,
          ),
      )
      .map(({ selector }) => selector);
    expect(sheetRules.length).toBeGreaterThan(
      { "site.css": 100, "lab.css": 50, "depth.css": 25, "mcp-app.css": 50 }[
        name
      ],
    );
    expect(unpulled).toEqual([]);
  });
});

describe("a page in two columns", () => {
  test("starts both at the same rule line", () => {
    // One rule holds every column that starts a two-column page.
    const ruled = rules.filter(
      ({ selector, body }) =>
        selector.split(/,\s*/).includes(".evenings-head") &&
        body.includes(
          "border-top: var(--at-stroke-rule) solid var(--at-text)",
        ) &&
        body.includes("padding-top: var(--at-space-3)"),
    );
    expect(ruled).toHaveLength(1);
    const ruledSelector = ruled[0]?.selector ?? "";
    const columns = ruledSelector.split(/,\s*/);
    for (const column of [
      ".band > .pitch",
      ".lists",
      ".evenings-head",
      ".evenings-lists .list",
      ".about-head",
      ".about-part",
    ]) {
      expect(columns).toContain(column);
    }
  });
});

describe("a statement beside another column", () => {
  test("stands at the foot of its cell, every one by the one rule", () => {
    // The pitch is a flex column (its sentences stacked), so the end of
    // its main axis is the bottom of the cell it stretches to fill.
    const pitch = rules.find(({ selector }) => selector === ".pitch");
    expect(pitch?.body).toContain("display: flex");
    expect(pitch?.body).toContain("flex-direction: column");
    const anchored = rules.filter(({ body }) =>
      body.includes("justify-content: flex-end"),
    );
    expect(anchored.map(({ selector }) => selector)).toEqual([
      ".band > .pitch",
    ]);
    expect(anchored[0]?.body).toContain("align-self: stretch");
    // Its cell spans the row: nothing in the band aligns it otherwise.
    for (const { selector, body } of rules) {
      if (selector.split(/,\s*/).some((part) => /^\.band\b/.test(part))) {
        expect(body).not.toMatch(/align-(?:items|self|content): (?!stretch)/);
      }
    }
  });
});

describe("the home page's two sentences", () => {
  test("take their type from the lead role alone", () => {
    for (const selector of [".pitch", ".pitch-place"]) {
      const block = new RegExp(
        `(?:^|\\n)${selector.replace(".", "\\.")} \\{([^}]*)\\}`,
      ).exec(site)?.[1];
      expect(block).toBeDefined();
      expect(block).not.toMatch(
        /font-(?:size|weight|family|stretch)|line-height|letter-spacing/,
      );
    }
  });
});
