import { expect, test, type Page } from "@playwright/test";

async function setLimit(page: Page, m: number) {
  const num = page.getByLabel("Maximum distance between rests in meters");
  await num.fill(String(m));
  await num.press("Enter");
}

async function pickDemoTrip(page: Page) {
  await page.goto("/#example");
  await page.getByLabel("Example walks").selectOption("slider-demo");
  await expect(page.getByTestId("status-heading")).toBeVisible();
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
  // route drawn as map paths, numbered seats shown
  await expect(page.locator("path.route-leg:not(.over)")).toHaveCount(9);
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
  await expect(page.locator("path.route-leg.over")).toHaveCount(2);
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
          { id: "boston", name: "Boston Garden", lat: 42.35, lon: -71.07 },
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
    await input.fill("Boston");
    await input.press("Enter");
    await page.getByRole("option").getByRole("button").click();
  }
  await page.getByRole("button", { name: "Find my walk" }).click();
  await expect(page.getByRole("alert")).toContainText("could not be loaded");
  await expect(page.locator("path.route-leg")).toHaveCount(0);
  await expect(page.getByTestId("demo-indicator")).toHaveCount(0);
});

test("disconnected trip is explained, not drawn", async ({ page }) => {
  await page.goto("/#example");
  await page.getByLabel("Example walks").selectOption("disconnected");
  await expect(page.getByTestId("status-heading")).toHaveText(
    "No connected walking route",
  );
});

test("map tile failure leaves route lines and text usable", async ({
  page,
}) => {
  await page.route(/tile\.openstreetmap\.org/, (r) => r.abort());
  await pickDemoTrip(page);
  await page.getByText("Map options & experiments", { exact: true }).click();
  await page.getByLabel("Show street map").check();
  await expect(page.getByTestId("tile-error")).toBeVisible();
  await expect(page.getByTestId("leg-list")).toBeVisible();
  await expect(page.locator("path.route-leg:not(.over)").first()).toBeVisible();
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
  await expect(page.locator(".leaflet-container")).toBeHidden();
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

test("mobile: results panel collapses @mobile", async ({ page, isMobile }) => {
  test.skip(!isMobile, "mobile only");
  await pickDemoTrip(page);
  const toggle = page.getByRole("button", { name: "Hide route details" });
  await toggle.click();
  await expect(page.getByTestId("leg-list")).toBeHidden();
  await page.getByRole("button", { name: "Show route details" }).click();
  await expect(page.getByTestId("leg-list")).toBeVisible();
});

test("propose a hypothetical bench closes the gap at 100 m", async ({
  page,
}) => {
  await pickDemoTrip(page);
  await setLimit(page, 100);
  await expect(page.getByTestId("status-heading")).toContainText(
    "Limit not met",
  );
  const gapLeg = page.locator("path.route-leg.over").first();
  const box = await gapLeg.boundingBox();
  await page.getByText("Map options & experiments", { exact: true }).click();
  await page.getByText("Try adding a bench", { exact: true }).click();
  await page
    .getByRole("button", { name: "Place a hypothetical bench" })
    .click();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
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
    fullPage: true,
  });
});
