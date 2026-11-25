/**
 * How the view moves from one state to the next: a view transition, where
 * the browser has them and the reader hasn't asked for less motion, so a
 * list hands over to an evening's lineup and back rather than blinking
 * between them. Everywhere else, the next state simply takes its place.
 */

/** Whether the reader asked for less motion. */
export const prefersLessMotion = (): boolean =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type WithTransitions = Document & {
  readonly startViewTransition?: (update: () => void) => {
    readonly updateCallbackDone?: Promise<void>;
  };
};

/**
 * Puts `next` in `target`'s place, and resolves once it is there: a view
 * transition puts it there only after it has captured the old state, so
 * a caller moving focus into `next` waits for this first. `direction` says
 * which way it reads: forward into a lineup, back to the list
 * (mcp-app.css slides each its own way).
 */
export async function swap(
  target: HTMLElement | null,
  next: HTMLElement,
  direction: "forward" | "back" = "forward",
): Promise<void> {
  if (target === null) return;
  const update = () => target.replaceChildren(next);
  const start = (document as WithTransitions).startViewTransition;
  if (typeof start !== "function" || prefersLessMotion()) {
    update();
    return;
  }
  document.documentElement.dataset["direction"] = direction;
  const transition = start.call(document, update);
  try {
    await transition.updateCallbackDone;
  } catch {
    // The update ran or failed on its own; the content is what it is.
  }
  // A transition the browser skipped never ran the update.
  if (!target.contains(next)) update();
}
