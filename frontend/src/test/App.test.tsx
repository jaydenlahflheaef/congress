import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { config, okRoute } from "./fixtures";

vi.mock("../components/RouteMap", () => ({
  default: (p: {
    result: { stops: { number: number; id: string }[] } | null;
  }) => (
    <div data-testid="map">
      {p.result?.stops.map((s) => (
        <span key={s.id} data-testid="map-stop">
          {s.number}:{s.id}
        </span>
      ))}
    </div>
  ),
}));
const json = (data: unknown) =>
  ({ ok: true, status: 200, json: async () => data }) as Response;

describe("App", () => {
  let routeBodies: {
    excluded_seat_ids: string[];
    max_gap_m: number;
    dataset_mode: string;
    dataset_id: string;
  }[];
  let areaCalls: number;
  let areaError: boolean;
  beforeEach(() => {
    routeBodies = [];
    areaCalls = 0;
    areaError = false;
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/config")) return json(config);
        if (url.startsWith("/api/seats"))
          return json({ status: "ok", seats: [] });
        if (url.startsWith("/api/places"))
          return json({ status: "ok", places: [] });
        if (url.startsWith("/api/search"))
          return json({
            status: "ok",
            places: [
              {
                id: "boston",
                name: "Boston Garden",
                lat: 42.35,
                lon: -71.07,
                source: "osm",
                category: "park",
              },
            ],
          });
        if (url === "/api/areas") {
          areaCalls++;
          return areaError
            ? json({
                status: "error",
                message: "Walking paths could not be loaded. Please try again.",
              })
            : json({
                status: "ready",
                dataset_id: "boston-area",
                config: { mode: "nearby", available: true },
                seats: [],
              });
        }
        if (url.startsWith("/api/route")) {
          const body = JSON.parse(String(init?.body));
          routeBodies.push(body);
          const stops = ["s1", "s2", "s3"].filter(
            (s) => !body.excluded_seat_ids.includes(s),
          );
          return json({
            ...okRoute(body.max_gap_m, stops, 300 + 10 * (3 - stops.length)),
            data_mode: body.dataset_mode,
          });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("opens the real planner without a mode chooser or fictional trip", async () => {
    render(<App />);
    expect(await screen.findByRole("combobox", { name: "From" })).toHaveValue(
      "",
    );
    expect(screen.queryByText("Flushing pilot")).toBeNull();
    expect(screen.queryByTestId("demo-indicator")).toBeNull();
    expect(screen.getByRole("button", { name: "Find my walk" })).toBeDisabled();
    expect(areaCalls).toBe(0);
  });

  it("example walks load their area and route with the suggested limit", async () => {
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Flushing–Main St station to Queens Public Library at Flushing",
      }),
    );
    await waitFor(() => expect(routeBodies.length).toBe(1));
    expect(areaCalls).toBe(1);
    expect(routeBodies[0]).toMatchObject({
      max_gap_m: 400,
      dataset_mode: "nearby",
      dataset_id: "boston-area",
    });
    expect(screen.queryByTestId("examples")).toBeNull();
  });

  it("keeps the fictional example behind How it works", async () => {
    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: "How it works" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Try an example walk" }),
    );
    expect(await screen.findByTestId("demo-indicator")).toHaveTextContent(
      "fictional",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "← Plan a real walk" }),
    );
    expect(screen.queryByTestId("demo-indicator")).toBeNull();
  });

  it("excluding a seat re-routes and renumbers the stops and metrics", async () => {
    window.history.replaceState(null, "", "/#example");
    render(<App />);
    await userEvent.selectOptions(
      await screen.findByLabelText("Example walks"),
      "demo",
    );
    await waitFor(() =>
      expect(screen.getByTestId("metric-rests")).toHaveTextContent("3"),
    );
    expect(screen.getAllByTestId("map-stop").map((e) => e.textContent)).toEqual(
      ["1:s1", "2:s2", "3:s3"],
    );
    const stopsList = screen.getByRole("heading", { name: "Planned rests" })
      .nextElementSibling as HTMLElement;
    await userEvent.click(
      within(within(stopsList).getAllByRole("listitem")[0]).getByRole(
        "button",
        { name: "Exclude this seat" },
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("metric-rests")).toHaveTextContent("2"),
    );
    expect(routeBodies.at(-1)!.excluded_seat_ids).toEqual(["s1"]);
    expect(screen.getAllByTestId("map-stop").map((e) => e.textContent)).toEqual(
      ["1:s2", "2:s3"],
    );
    expect(screen.getByTestId("metric-total")).toHaveTextContent("310 m");
  });

  it("remembers only the slider preference in localStorage", async () => {
    render(<App />);
    const num = await screen.findByLabelText(
      "Maximum distance between rests in meters",
    );
    await userEvent.clear(num);
    await userEvent.type(num, "230{Enter}");
    expect(window.localStorage.getItem("restroute.maxGap")).toBe("230");
    expect(Object.keys(window.localStorage)).toEqual(["restroute.maxGap"]);
  });

  async function selectPlaces() {
    for (const label of ["From", "To"]) {
      const input = await screen.findByRole("combobox", { name: label });
      await userEvent.type(input, "Boston{Enter}");
      await userEvent.click(
        await screen.findByRole("button", { name: /Boston Garden/ }),
      );
    }
  }

  it("loads a real area once and reuses it for slider changes", async () => {
    render(<App />);
    await selectPlaces();
    await userEvent.click(screen.getByRole("button", { name: "Find my walk" }));
    await waitFor(() => expect(routeBodies).toHaveLength(1));
    expect(routeBodies[0].dataset_mode).toBe("nearby");
    expect(routeBodies[0].dataset_id).toBe("boston-area");
    const num = screen.getByLabelText(
      "Maximum distance between rests in meters",
    );
    await userEvent.clear(num);
    await userEvent.type(num, "100{Enter}");
    await waitFor(() => expect(routeBodies.at(-1)?.max_gap_m).toBe(100));
    expect(areaCalls).toBe(1);
  });

  it("failed real data loading never switches to fictional seats", async () => {
    areaError = true;
    render(<App />);
    await selectPlaces();
    await userEvent.click(screen.getByRole("button", { name: "Find my walk" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not be loaded",
    );
    expect(routeBodies).toHaveLength(0);
    expect(screen.queryByTestId("demo-indicator")).toBeNull();
  });
});
