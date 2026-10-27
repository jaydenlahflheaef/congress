import { useCallback, useEffect, useRef, useState } from "react";

type OrientationEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };
type IosOrientation = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

const shortest = (from: number, to: number) => ((to - from + 540) % 360) - 180;

/**
 * Which way the phone is facing, in degrees from north (null until known).
 * iPhones only allow this after a tap, so call `request()` from a click handler.
 */
export function useCompass(active: boolean) {
  const [heading, setHeading] = useState<number | null>(null);
  const [allowed, setAllowed] = useState(false);
  const smooth = useRef<number | null>(null);
  const lastPush = useRef(0);

  const request = useCallback(async () => {
    const ctor = window.DeviceOrientationEvent as IosOrientation | undefined;
    if (!ctor) return false;
    // Listen either way: if the person declines, no readings arrive and the
    // map simply stays facing north. The permission call must happen in a tap.
    setAllowed(true);
    if (typeof ctor.requestPermission === "function") {
      try {
        return (await ctor.requestPermission()) === "granted";
      } catch {
        return false;
      }
    }
    return true;
  }, []);

  useEffect(() => {
    if (!active || !allowed) {
      smooth.current = null;
      setHeading(null);
      return;
    }
    const onEvent = (e: Event) => {
      const ev = e as OrientationEvent;
      let raw: number | null = null;
      if (typeof ev.webkitCompassHeading === "number") raw = ev.webkitCompassHeading; // iPhone
      else if (ev.alpha !== null && ev.absolute) raw = (360 - ev.alpha) % 360; // Android
      if (raw === null || !Number.isFinite(raw)) return;
      // Low-pass filter around the circle so the needle does not jitter at 359/0.
      smooth.current =
        smooth.current === null ? raw : (smooth.current + 0.3 * shortest(smooth.current, raw) + 360) % 360;
      const now = performance.now();
      if (now - lastPush.current > 80) {
        lastPush.current = now;
        setHeading(smooth.current);
      }
    };
    // Android sends north-referenced readings on "deviceorientationabsolute" (and
    // sometimes on the plain event); iPhones send webkitCompassHeading on the
    // plain event. Plain readings that are not north-referenced are ignored above.
    window.addEventListener("deviceorientationabsolute", onEvent);
    window.addEventListener("deviceorientation", onEvent);
    return () => {
      window.removeEventListener("deviceorientationabsolute", onEvent);
      window.removeEventListener("deviceorientation", onEvent);
    };
  }, [active, allowed]);

  return { heading, request };
}
