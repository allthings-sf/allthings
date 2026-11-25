import { h, svg } from "./dom.ts";

/**
 * Where we met, drawn: a schematic map of the neighborhoods our evenings
 * were in (core/src/places.ts names them), each a dot sized by how many
 * evenings it held, at its place on San Francisco's east side. The
 * neighborhoods without an evening that year stay as faint dots, for the
 * city around them. It is a diagram, not a street map: no tiles, nothing
 * fetched, and its title says in words everything the dots show.
 */

/** Where a neighborhood's name sits by its dot, so neighbors never collide. */
type Side = "above" | "below" | "left" | "right";

/**
 * Roughly the middle of each neighborhood places.ts knows, in degrees, and
 * the side its name goes. Only for placing dots against each other; never
 * an evening's address.
 */
const centers: Readonly<
  Record<
    string,
    { readonly at: readonly [number, number]; readonly side: Side }
  >
> = {
  FiDi: { at: [37.7946, -122.3999], side: "above" },
  "East Cut": { at: [37.789, -122.3925], side: "right" },
  "Union Square": { at: [37.788, -122.4075], side: "left" },
  "Mid-Market": { at: [37.779, -122.414], side: "left" },
  SoMa: { at: [37.7785, -122.4056], side: "below" },
  "Mission Bay": { at: [37.7706, -122.3916], side: "right" },
  Mission: { at: [37.7599, -122.4148], side: "left" },
  "Potrero Hill": { at: [37.7605, -122.4009], side: "below" },
  Dogpatch: { at: [37.7585, -122.388], side: "right" },
};

const width = 520;
const height = 420;
const padX = 130;
const padY = 56;

/** The map's box: every center, so each year's map draws the same city. */
const lats = Object.values(centers).map(({ at: [lat] }) => lat);
const lngs = Object.values(centers).map(({ at: [, lng] }) => lng);
const [north, south] = [Math.max(...lats), Math.min(...lats)];
const [west, east] = [Math.min(...lngs), Math.max(...lngs)];
// A degree of longitude is shorter than one of latitude here.
const squash = Math.cos(((north + south) / 2) * (Math.PI / 180));
const scale = Math.min(
  (width - 2 * padX) / ((east - west) * squash),
  (height - 2 * padY) / (north - south),
);
// Centered across, whatever is left over.
const offsetX = (width - (east - west) * squash * scale) / 2;

const pointOf = (lat: number, lng: number) => ({
  x: offsetX + (lng - west) * squash * scale,
  y: padY + (north - lat) * scale,
});

/** Where the name goes for a dot of radius `r` at `x`, `y`. */
function labelAt(
  side: Side,
  x: number,
  y: number,
  r: number,
): { x: number; y: number; anchor: string } {
  const gap = 8;
  const at: Record<Side, { x: number; y: number; anchor: string }> = {
    above: { x, y: y - r - gap, anchor: "middle" },
    below: { x, y: y + r + gap + 12, anchor: "middle" },
    left: { x: x - r - gap, y: y + 5, anchor: "end" },
    right: { x: x + r + gap, y: y + 5, anchor: "start" },
  };
  return at[side];
}

/** How many evenings each neighborhood held, most first. */
export type Tally = ReadonlyArray<readonly [string, number]>;

export function neighborhoodMap(tally: Tally, label: string): HTMLElement {
  const held = new Map(tally.filter(([name]) => Object.hasOwn(centers, name)));
  const most = Math.max(1, ...held.values());
  const titleId = "map-title";
  const quiet = Object.entries(centers)
    .filter(([name]) => !held.has(name))
    .map(
      ([
        ,
        {
          at: [lat, lng],
        },
      ]) => {
        const { x, y } = pointOf(lat, lng);
        return svg("circle", { class: "map-quiet", cx: x, cy: y, r: 4 });
      },
    );
  const dots = [...held.entries()].map(([name, n]) => {
    const { at, side } = centers[name] ?? { at: [north, west], side: "right" };
    const { x, y } = pointOf(at[0], at[1]);
    const r = 9 + 13 * Math.sqrt(n / most);
    const text = labelAt(side, x, y, r);
    return svg(
      "g",
      { class: "map-place" },
      svg("circle", { class: "map-dot", cx: x, cy: y, r }),
      svg(
        "text",
        { class: "map-count", x, y: y + 5, "text-anchor": "middle" },
        String(n),
      ),
      svg(
        "text",
        {
          class: "map-label",
          x: text.x,
          y: text.y,
          "text-anchor": text.anchor,
        },
        name,
      ),
    );
  });
  // The Bay is to the east of every one of them.
  const bay = svg(
    "text",
    { class: "map-water", x: width - 16, y: height / 2, "text-anchor": "end" },
    "The Bay",
  );
  const drawing = svg(
    "svg",
    {
      class: "map",
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-labelledby": titleId,
      focusable: "false",
    },
    svg(
      "title",
      { id: titleId },
      `${label}: ${[...held.entries()].map(([name, n]) => `${name}, ${n === 1 ? "1 evening" : `${n} evenings`}`).join("; ")}.`,
    ),
    bay,
    ...quiet,
    ...dots,
  );
  return h(
    "figure",
    { class: "map-figure" },
    drawing,
    h(
      "figcaption",
      { class: "at-type-meta" },
      "San Francisco’s east side, as a diagram: not to scale.",
    ),
  );
}
