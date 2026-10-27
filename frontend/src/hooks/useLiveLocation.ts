import { useEffect, useState } from "react";

export interface LiveFix {
  lat: number;
  lon: number;
  /** Meters; how far off the phone says the position could be. */
  accuracy: number;
  /** Direction of travel in degrees from north, or null when standing still. */
  travelHeading: number | null;
}

/** Follows the phone's position while `active`; clears it when switched off. */
export function useLiveLocation(active: boolean) {
  const [fix, setFix] = useState<LiveFix | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    if (!active) {
      setFix(null);
      return;
    }
    if (!navigator.geolocation?.watchPosition) {
      setDenied(true);
      return;
    }
    setDenied(false);
    const id = navigator.geolocation.watchPosition(
      (pos) =>
        setFix({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          travelHeading:
            pos.coords.heading !== null &&
            Number.isFinite(pos.coords.heading) &&
            (pos.coords.speed ?? 0) > 0.6
              ? pos.coords.heading
              : null,
        }),
      () => setDenied(true),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [active]);

  return { fix, denied };
}
