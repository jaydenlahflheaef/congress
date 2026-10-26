# Running and hosting Rest Route

The current planner loads real walking areas on demand. Use **one persistent Python process** with outbound HTTPS access and writable storage. The worker prepares map data while the browser polls for progress; slider updates use cached local data.

The older Vercel serverless setup in `vercel.json` and `index.py` is retained for reference, but it is **not a supported deployment for this background area-loading workflow**. A request can land on a different function instance, and background work may be suspended. No deployment has been performed in this update.

## Local app

From the repository root, with Python 3.13+ and Node 22+:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
npm --prefix frontend ci
npm --prefix frontend run build
.venv/bin/python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000 --no-access-log
```

Open http://127.0.0.1:8000. On Windows use `.venv\Scripts\python`.

## Persistent host

The included Dockerfile builds the frontend and serves it from FastAPI. Deploy that container to a host supporting an always-running service and persistent storage when you are ready. Put HTTPS in front of port 8000. Keep a single worker/replica for now, because progress, active datasets, and the provider rate limiter are held in process memory. A production service serving many users will need a shared queue, cache, quotas, and an appropriate map-data provider.

Mount persistent storage at `/app/data/areas`, or configure `REST_ROUTE_AREA_CACHE`. Local Docker Compose mounts `./data/areas` there. Old on-disk areas are not reused after seven days; at most twelve area artifacts are retained. Only four areas are held in memory. A route for an evicted area must load it again (usually from disk).

Provider settings:

- `REST_ROUTE_GEOCODER_URL`: Photon-compatible endpoint, default `https://photon.komoot.io/api/`. Explicit user searches only; cached, serialized and limited to one request per second in this process. Public Photon is for reasonable small-project use and has no availability guarantee: https://github.com/komoot/photon.
- `REST_ROUTE_OVERPASS_URL`: default `https://overpass-api.de/api`. Used by OSMnx for new areas, not slider reroutes. Provider congestion can make first loads slow or fail.
- `VITE_TILE_URL` and `VITE_TILE_ATTRIBUTION`: replaceable tile provider, set before frontend build. Preserve attribution and respect provider usage limits.

Location requests require HTTPS outside localhost. Access logs should stay disabled because search strings are in query URLs. Application code does not log trip coordinates. Place searches go to Photon; a rounded surrounding area goes to Overpass; map tile requests disclose the viewport. No credentials or private trip names are saved in area artifacts.

## iPhone app path

The current deliverable is a responsive web app, not a compiled iOS app.

To package the existing React interface for iPhone:

1. Host the Python backend at an HTTPS URL with the persistent process described above.
2. Add Capacitor to `frontend`, set its `webDir` to `dist`, and add the iOS platform.
3. Set `VITE_API_BASE` to the hosted backend URL before building. Configure backend CORS for the intended Capacitor origin, not all origins.
4. Build the web assets, synchronize Capacitor, and open the generated iOS project in Xcode on a Mac.
5. Configure signing, app icons, location permission wording/native integration, and printing/sharing behavior. Test on an iPhone and with VoiceOver.
6. Use the Apple distribution route appropriate to your goal (personal device testing, TestFlight, or App Store submission). App Store acceptance is not guaranteed by wrapping a website.

Official setup: https://capacitorjs.com/docs/getting-started and https://capacitorjs.com/docs/ios.

For a quicker Home Screen experience, a hosted web version can be added from Safari. That is a separate delivery option; this update has not added offline support, a service worker, or native packaging.
