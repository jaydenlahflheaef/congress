import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

/** Live result of a CSS media query (false where matchMedia is unavailable). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => window.matchMedia?.(query).matches ?? false,
  );
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** Rendered height of an element, updated when it changes size. */
export function useHeight(ref: RefObject<HTMLElement | null>, fallback: number): number {
  const [height, setHeight] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setHeight(el.offsetHeight);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return height;
}

/**
 * Distance from the top of the viewport to an element's bottom edge. Takes the
 * element itself (from a callback ref), so it measures whenever it appears.
 */
export function useBottomEdge(el: HTMLElement | null, fallback: number): number {
  const [bottom, setBottom] = useState(fallback);
  useLayoutEffect(() => {
    if (!el) return;
    const update = () => setBottom(Math.round(el.getBoundingClientRect().bottom));
    update();
    window.addEventListener("resize", update);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => {
      window.removeEventListener("resize", update);
      ro?.disconnect();
    };
  }, [el]);
  return bottom;
}
