import { defineConfig, devices } from "@playwright/test";

// Runs the real backend (synthetic demo + no pilot data) serving the built frontend.
// Build first: npm run build
const PORT = 8765;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: `${process.env.REST_ROUTE_PYTHON ?? "../.venv/bin/python"} -m uvicorn app.main:app --port ${PORT} --no-access-log`,
    cwd: "../backend",
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    env: {
      REST_ROUTE_PILOT_DIR: "/nonexistent-rest-route-pilot",
      // The tests strip the key from Google's requests, so the map always runs
      // in Google's keyless development mode; any value makes the app show it.
      GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY || "test-placeholder",
    },
    timeout: 60_000,
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 860 },
      },
    },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
});
