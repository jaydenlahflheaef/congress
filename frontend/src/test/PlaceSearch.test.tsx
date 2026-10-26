import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { PlaceSearch } from "../components/PlaceSearch";

afterEach(() => vi.unstubAllGlobals());
it("searches only on submission and supports keyboard selection", async () => {
  const onChange = vi.fn();
  const fetcher = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      places: [{ id: "1", name: "Library, Boston", lat: 42, lon: -71 }],
    }),
  }));
  vi.stubGlobal("fetch", fetcher);
  render(
    <PlaceSearch label="From" mode="nearby" value={null} onChange={onChange} />,
  );
  const input = screen.getByRole("combobox");
  await userEvent.type(input, "Boston");
  expect(fetcher).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("option");
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(onChange).toHaveBeenCalledWith({
    name: "Library, Boston",
    lat: 42,
    lon: -71,
  });
  expect(screen.queryByRole("listbox")).toBeNull();
});
it("discards a late response after the query changes", async () => {
  let resolve!: (r: unknown) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    ),
  );
  render(
    <PlaceSearch label="From" mode="nearby" value={null} onChange={vi.fn()} />,
  );
  const input = screen.getByRole("combobox");
  await userEvent.type(input, "Boston{Enter}");
  await userEvent.clear(input);
  await userEvent.type(input, "London");
  resolve({
    ok: true,
    json: async () => ({
      places: [{ id: "1", name: "Boston", lat: 42, lon: -71 }],
    }),
  });
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect(input).toHaveValue("London");
});
