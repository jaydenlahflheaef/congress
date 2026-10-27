/** Small map-geometry helpers, kept free of Google Maps so they can be tested. */

/**
 * A screen-space offset expressed in the frame of the map layer, which is
 * turned clockwise by `rotationDeg` (CSS rotate). Dragging a finger right on
 * a map turned 90 degrees clockwise is "up" in the layer's own frame.
 */
export function toMapFrame(dx: number, dy: number, rotationDeg: number) {
  const t = (rotationDeg * Math.PI) / 180;
  return { x: Math.cos(t) * dx + Math.sin(t) * dy, y: -Math.sin(t) * dx + Math.cos(t) * dy };
}

/** Rotation that puts `heading` (degrees from north) at the top of the screen, taking the short way round. */
export function turnToHeading(current: number, heading: number): number {
  return current + ((((-heading - current) % 360) + 540) % 360) - 180;
}
