import { expect, test, type Page } from "@playwright/test";

// The map is Google Maps, run in Google's keyless development mode: the key is
// stripped from Google's requests, so tests work on any machine and do not use
// the real key (which is locked to the deployed site). Route lines are drawn on
// a canvas, so map state is read from the map element's data attributes, and
// the test hook below turns coordinates into screen positions.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__REST_ROUTE_TEST__ = true;
  });
  await page.route(/maps\.googleapis\.com/, (r) => {
    const url = new URL(r.request().url());
    url.searchParams.delete("key");
    return r.continue({ url: url.toString() });
  });
});

/** Development mode shows a notice over the map; close it before tapping the map. */
async function dismissDevNotice(page: Page) {
  const ok = page.locator(".dismissButton");
  if (await ok.count()) await ok.first().click().catch(() => undefined);
}

async function setLimit(page: Page, m: number) {
  const num = page.getByLabel("Maximum distance between rests in meters");
  await num.fill(String(m));
  await num.press("Enter");
}

/** On phones the sheet lowers after a route is found; raise it to read the details. */
async function expandSheet(page: Page) {
  const expand = page.getByRole("button", { name: "Expand panel" });
  if (await expand.isVisible()) await expand.click();
}

async function pickDemoTrip(page: Page) {
  await page.goto("/#example");
  await page.getByLabel("Example walks").selectOption("slider-demo");
  await expandSheet(page);
  await expect(page.getByTestId("status-heading")).toBeVisible();
}

/** The point halfway along a [lon, lat] polyline (flat approximation, fine over metres). */
function halfway(coords: [number, number][]): [number, number] {
  const seg = coords.slice(1).map((p, i) => Math.hypot(p[0] - coords[i][0], p[1] - coords[i][1]));
  let left = seg.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < seg.length; i++) {
    if (left <= seg[i]) {
      const t = left / seg[i];
      return [
        coords[i][0] + t * (coords[i + 1][0] - coords[i][0]),
        coords[i][1] + t * (coords[i + 1][1] - coords[i][1]),
      ];
    }
    left -= seg[i];
  }
  return coords[coords.length - 1];
}

/** Screen position of a coordinate on the Google map. */
async function screenPoint(page: Page, lat: number, lng: number) {
  return page.evaluate(
    ([lat, lng]) => {
      const g = (window as unknown as { google: typeof google }).google;
      const map = (window as unknown as { __restRouteMap: google.maps.Map })
        .__restRouteMap;
      const proj = map.getProjection()!;
      const b = map.getBounds()!;
      const scale = 2 ** map.getZoom()!;
      const nw = proj.fromLatLngToPoint(
        new g.maps.LatLng(b.getNorthEast().lat(), b.getSouthWest().lng()),
      )!;
      const p = proj.fromLatLngToPoint(new g.maps.LatLng(lat, lng))!;
      const rect = map.getDiv().getBoundingClientRect();
      return {
        x: rect.left + (p.x - nw.x) * scale,
        y: rect.top + (p.y - nw.y) * scale,
      };
    },
    [lat, lng],
  );
}

test("feasible flow: slider changes the route from real results", async ({
  page,
}) => {
  await pickDemoTrip(page);
  await expect(page.getByTestId("demo-indicator")).toBeVisible();
  await expect(page.getByTestId("status-heading")).toContainText(
    "Within your selected limit",
  );
  await expect(page.getByTestId("metric-total")).toHaveText("622 m");
  await expect(page.getByTestId("metric-rests")).toHaveText("1");
  await setLimit(page, 150);
  await expect(page.getByTestId("metric-total")).toHaveText("904 m");
  await expect(page.getByTestId("metric-rests")).toHaveText("8");
  await expect(page.getByTestId("status-heading")).toContainText("(150 m)");
  // the map draws the same route: nine legs, eight numbered seats
  await expect(page.getByTestId("route-map")).toHaveAttribute("data-legs", "9");
  await expect(page.getByTestId("route-map")).toHaveAttribute("data-over-legs", "0");
  await expect(page.locator(".map-pin.stop")).toHaveCount(8);
});

test("limit-unmet flow: fallback shows smallest achievable gap and amber legs", async ({
  page,
}) => {
  await pickDemoTrip(page);
  await setLimit(page, 100);
  await expect(page.getByTestId("status-heading")).toContainText(
    "Limit not met",
  );
  await expect(page.getByTestId("status-message")).toContainText(
    "smallest achievable longest gap is 136 m",
  );
  await expect(page.locator("button.leg.over")).toHaveCount(2);
  await expect(page.getByTestId("route-map")).toHaveAttribute("data-over-legs", "2");
  // selecting a leg highlights it
  await page.locator("button.leg.over").first().click();
  await expect(page.locator("button.leg.over").first()).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("no-data flow: unavailable real area stays real @mobile", async ({
  page,
}) => {
  await page.route("**/api/search?*", (r) =>
    r.fulfill({
      json: {
        status: "ok",
        places: [
          { id: "flushing", name: "Flushing Town Hall", lat: 40.7639, lon: -73.8301 },
        ],
      },
    }),
  );
  await page.route("**/api/areas", (r) =>
    r.fulfill({
      json: {
        status: "error",
        message: "Walking paths could not be loaded. Please try again.",
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByTestId("demo-indicator")).toHaveCount(0);
  for (const label of ["From", "To"]) {
    const input = page.getByRole("combobox", { name: label, exact: true });
    await input.fill("Flushing");
    await input.press("Enter");
    await page.getByRole("option").getByRole("button").click();
  }
  await page.getByRole("button", { name: "Find my walk" }).click();
  await expect(page.getByRole("alert")).toContainText("could not be loaded");
  await expect(page.getByTestId("route-map")).toHaveAttribute("data-legs", "0");
  await expect(page.getByTestId("demo-indicator")).toHaveCount(0);
});

test("disconnected trip is explained, not drawn", async ({ page }) => {
  await page.goto("/#example");
  await page.getByLabel("Example walks").selectOption("disconnected");
  await expandSheet(page);
  await expect(page.getByTestId("status-heading")).toHaveText(
    "No connected walking route",
  );
  await expect(page.getByTestId("route-map")).toHaveAttribute("data-legs", "0");
});

test("if Google Maps cannot load, the route list still works", async ({
  page,
}) => {
  await page.route(/maps\.googleapis\.com/, (r) => r.abort());
  await pickDemoTrip(page);
  await expect(page.getByTestId("map-error")).toBeVisible();
  await expect(page.getByTestId("leg-list")).toBeVisible();
  await expect(page.getByTestId("metric-total")).toHaveText("622 m");
});

test("if Google refuses the key, the rest of the app keeps working @mobile", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /Flushing Town Hall to Queens/ })
    .click();
  await expect(page.getByTestId("route-map")).not.toHaveAttribute("data-legs", "0");
  // Google calls this when a key is rejected (e.g. a site not on its allow list).
  await page.evaluate(() =>
    (window as unknown as { gm_authFailure?: () => void }).gm_authFailure?.(),
  );
  await expect(page.getByTestId("map-error")).toBeVisible();
  await expandSheet(page);
  await expect(page.getByTestId("leg-list")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "From", exact: true })).toBeVisible();
});

test("excluding a seat recalculates", async ({ page }) => {
  await pickDemoTrip(page);
  await expect(page.getByTestId("metric-total")).toHaveText("622 m");
  await page.getByRole("button", { name: "Exclude this seat" }).first().click();
  await expect(page.getByTestId("metric-total")).toHaveText("868 m");
  await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
});

test("print view shows a text summary without the map", async ({ page }) => {
  await pickDemoTrip(page);
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("print-summary")).toBeVisible();
  await expect(page.getByTestId("print-summary")).toContainText(
    "Total distance: 622 m",
  );
  await expect(page.getByTestId("route-map")).toBeHidden();
});

test("keyboard: limit can be changed with the keyboard @mobile", async ({
  page,
}) => {
  await pickDemoTrip(page);
  const slider = page.getByLabel("Maximum distance between rests (slider)");
  await slider.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByLabel("Maximum distance between rests in meters"),
  ).toHaveValue("390");
  await expect(page.getByTestId("status-heading")).toContainText("(390 m)");
});

test("mobile: the bottom sheet lowers and raises @mobile", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "mobile only");
  await pickDemoTrip(page);
  await expect(page.getByTestId("leg-list")).toBeVisible();
  await page.getByRole("button", { name: "Collapse panel" }).click();
  await expect(page.getByTestId("leg-list")).toBeHidden();
  // the summary and the slider stay in view while lowered
  await expect(
    page.getByLabel("Maximum distance between rests in meters"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Expand panel" }).click();
  await expect(page.getByTestId("leg-list")).toBeVisible();
});

test("propose a hypothetical bench closes the gap at 100 m", async ({
  page,
}) => {
  await pickDemoTrip(page);
  const unmet = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/route") &&
      JSON.parse(r.request().postData() ?? "{}").max_gap_m === 100,
  );
  await setLimit(page, 100);
  const route = await (await unmet).json();
  await expect(page.getByTestId("status-heading")).toContainText(
    "Limit not met",
  );
  // the halfway point along the first over-limit stretch lies on its walkway
  const over = route.route_geojson.features.find(
    (f: { properties: { over_limit: boolean } }) => f.properties.over_limit,
  );
  const [lng, lat] = halfway(over.geometry.coordinates);
  await page.getByText("Map options & experiments", { exact: true }).click();
  await page.getByText("Try adding a bench", { exact: true }).click();
  await page
    .getByRole("button", { name: "Place a hypothetical bench" })
    .click();
  await page.waitForTimeout(800); // let the map settle after the sheet moves
  await dismissDevNotice(page);
  const pt = await screenPoint(page, lat, lng);
  await page.mouse.click(pt.x, pt.y);
  await expandSheet(page);
  await expect(page.getByTestId("status-heading")).toContainText(
    "Within your selected limit",
  );
  await expect(page.getByTestId("hypo-compare")).toContainText("Limit not met");
  await expect(page.getByTestId("hypo-compare")).toContainText("136 m");
  await expect(page.locator(".map-pin.stop.hyp")).toHaveCount(1);
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect(page.getByTestId("status-heading")).toContainText(
    "Limit not met",
  );
});

test("example is optional and returning home clears fictional results", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: "How it works" }).click();
  await page.getByRole("button", { name: "Try an example walk" }).click();
  await page.getByLabel("Example walks").selectOption("slider-demo");
  await expect(page.getByTestId("metric-total")).toHaveText("622 m");
  await page
    .getByRole("button", { name: "Plan a real walk", exact: false })
    .click();
  await expect(page.getByTestId("demo-indicator")).toHaveCount(0);
  await expect(page.getByTestId("metric-total")).toHaveCount(0);
  await expect(
    page.getByRole("combobox", { name: "From", exact: true }),
  ).toHaveValue("");
  expect(errors).toEqual([]);
});

test("real planner fits mobile and has no automatic location prompt @mobile", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Find my walk" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "From", exact: true }),
  ).toBeVisible();
  const width = await page.evaluate(() => ({
    body: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(width.body).toBeLessThanOrEqual(width.viewport);
  await page.screenshot({
    path: `test-results/planner-${test.info().project.name}.png`,
  });
});

test("Flushing example walk routes on real NYC data with Google Maps links @mobile", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", {
      name: "Flushing–Main St station to Queens Public Library at Flushing",
    })
    .click();
  // the lowered sheet already offers turn-by-turn directions to the first stop
  await expect(
    page.getByRole("link", { name: /^Start walking: directions to/ }),
  ).toHaveAttribute("href", /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/);
  await page.screenshot({
    path: `test-results/flushing-${test.info().project.name}.png`,
  });
  await expandSheet(page);
  await expect(page.getByTestId("status-heading")).toContainText(
    "Within your selected limit",
  );
  await expect(page.getByTestId("demo-indicator")).toHaveCount(0);
  const links = page.getByRole("link", { name: /^Walking directions to .* in Google Maps$/ });
  await expect(links.first()).toHaveAttribute(
    "href",
    /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=40\.7\d+,-73\.8\d+&travelmode=walking$/,
  );
  expect(await links.count()).toBe(
    await page.getByTestId("leg-list").locator("li").count(),
  );
  await expect(page.getByTestId("route-map")).toHaveAttribute(
    "data-legs",
    String(await links.count()),
  );
});

test("home screen app manifest and icon are served", async ({ request }) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBe(true);
  expect(manifest.headers()["content-type"]).toContain("application/manifest+json");
  expect((await manifest.json()).display).toBe("standalone");
  const icon = await request.get("/apple-touch-icon.png");
  expect(icon.headers()["content-type"]).toBe("image/png");
});
