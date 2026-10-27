import { useEffect, useRef, useState, type ReactNode } from "react";
import { useHeight } from "../hooks/useLayout";

export type Snap = "peek" | "half" | "full";

interface Props {
  snap: Snap;
  onSnap: (s: Snap) => void;
  /** Always visible: the part shown when the sheet is lowered. */
  head: ReactNode;
  children: ReactNode;
  /** Space taken by the floating search card, which the raised sheet stops below. */
  topInset: number;
  mobile: boolean;
  /** Reports the visible height once the sheet settles (0 on desktop). */
  onHeight: (px: number) => void;
}

const HANDLE_PX = 28;

/**
 * A Google Maps-style bottom sheet on phones (drag the handle, or tap it to
 * open and close) and a fixed side panel on wider screens.
 */
export function Sheet({ snap, onSnap, head, children, topInset, mobile, onHeight }: Props) {
  const headRef = useRef<HTMLDivElement>(null);
  const headH = useHeight(headRef, 160);
  const [vh, setVh] = useState(window.innerHeight);
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ y: number; h: number; t: number } | null>(null);
  const dragged = useRef(false);

  useEffect(() => {
    const onResize = () => setVh(window.innerHeight);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const peekH = HANDLE_PX + headH;
  const fullH = Math.max(peekH, vh - topInset - 12);
  const heights: Record<Snap, number> = {
    peek: peekH,
    half: Math.min(fullH, Math.max(peekH, Math.round(vh * 0.5))),
    full: fullH,
  };
  const height = drag ?? heights[snap];

  useEffect(() => {
    if (drag === null) onHeight(mobile ? heights[snap] : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobile, snap, heights[snap], drag === null]);

  const toggle = () => onSnap(snap === "peek" ? "half" : "peek");
  const nearest = (h: number, velocity: number) => {
    // A quick flick moves one step in its direction, like native sheets.
    if (Math.abs(velocity) > 0.6) {
      const order: Snap[] = ["peek", "half", "full"];
      const i = order.indexOf(snap) + (velocity > 0 ? 1 : -1);
      return order[Math.max(0, Math.min(2, i))];
    }
    return (Object.keys(heights) as Snap[]).reduce((a, b) =>
      Math.abs(heights[a] - h) <= Math.abs(heights[b] - h) ? a : b,
    );
  };

  return (
    <section
      className={`sheet no-print ${drag !== null ? "dragging" : ""} snap-${snap}`}
      style={mobile ? { height } : undefined}
      aria-label="Plan and route details"
    >
      {mobile && (
        <button
          type="button"
          className="sheet-handle"
          aria-label={snap === "peek" ? "Expand panel" : "Collapse panel"}
          aria-expanded={snap !== "peek"}
          onClick={() => {
            // The click that follows a drag is not a tap.
            if (dragged.current) dragged.current = false;
            else toggle();
          }}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            start.current = { y: e.clientY, h: heights[snap], t: e.timeStamp };
            dragged.current = false;
          }}
          onPointerMove={(e) => {
            if (!start.current) return;
            const dy = start.current.y - e.clientY;
            if (drag === null && Math.abs(dy) < 4) return;
            setDrag(Math.max(peekH, Math.min(fullH, start.current.h + dy)));
          }}
          onPointerUp={(e) => {
            const s = start.current;
            start.current = null;
            if (!s || drag === null) return;
            dragged.current = true;
            const velocity = (s.y - e.clientY) / Math.max(1, e.timeStamp - s.t);
            onSnap(nearest(drag, velocity));
            setDrag(null);
          }}
          onPointerCancel={() => {
            start.current = null;
            setDrag(null);
          }}
        />
      )}
      <div className="sheet-head" ref={headRef}>
        {head}
      </div>
      <div className="sheet-body" hidden={mobile && snap === "peek" && drag === null}>
        {children}
      </div>
    </section>
  );
}
