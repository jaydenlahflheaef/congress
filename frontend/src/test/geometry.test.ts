import { describe, expect, it } from "vitest";
import { toMapFrame, turnToHeading } from "../geometry";

const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe("toMapFrame", () => {
  it("leaves drags unchanged when the map is not turned", () => {
    const c = toMapFrame(10, -4, 0);
    near(c.x, 10);
    near(c.y, -4);
  });
  it("maps a rightward drag to 'up' on a map turned 90 degrees clockwise", () => {
    const c = toMapFrame(1, 0, 90);
    near(c.x, 0);
    near(c.y, -1);
  });
  it("flips both directions on a map turned upside down", () => {
    const c = toMapFrame(3, 5, 180);
    near(c.x, -3);
    near(c.y, -5);
  });
  it("keeps the length of the drag", () => {
    const c = toMapFrame(3, 4, 37);
    near(Math.hypot(c.x, c.y), 5);
  });
});

describe("turnToHeading", () => {
  it("puts the facing direction at the top", () => {
    near(turnToHeading(0, 90), -90);
    near(turnToHeading(0, 0), 0);
  });
  it("takes the short way across north instead of spinning", () => {
    // facing 350 degrees, then 10 degrees: a 20 degree turn, not 340
    const first = turnToHeading(0, 350);
    near(first, 10);
    near(turnToHeading(first, 10) - first, -20);
  });
});
