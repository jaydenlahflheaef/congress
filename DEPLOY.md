# Running and hosting EzWay

EzWay runs as **one persistent Python process** that serves both the web page and the API. It reads its New York City map data from `data/nyc/` (committed), builds walking areas in a background worker, and needs outbound HTTPS only for place search (Photon). Keep a single worker/replica: area progress and the search rate limiter are held in process memory.

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

## Hosting on Render

`render.yaml` describes one web service built from the `Dockerfile` (frontend build, then the server with only `backend/requirements-server.txt`).

1. Sign in at https://dashboard.render.com with your GitHub account.
2. **New → Blueprint**, connect GitHub if asked, and give Render access to this repository.
3. Pick the repository and confirm. Render reads `render.yaml`, builds the image and starts the service. The first build takes several minutes.
4. Open the `https://….onrender.com` address it shows. `/api/health` should return `"status": "ok"`.

Every push to the connected branch redeploys automatically.

### The Google map key

1. In the Render dashboard, open the service, then **Environment → Add environment variable**: key `GOOGLE_MAPS_API_KEY`, value your key. Save; Render redeploys.
2. In Google Cloud (**APIs & Services → Credentials**), open the key and set **Application restrictions → Websites** to your Render address, e.g. `https://rest-route.onrender.com/*`. Keep **API restrictions** on Maps JavaScript API. A browser key is visible in the page by design; these restrictions stop other sites from using it.
3. Optional: set a budget alert in Google Cloud Billing. Google's free monthly allowance covers a small project, but check Google's current pricing.

Never commit the key. For local runs, put it in `.env` (ignored by Git) and load it into the environment before starting the server. A key locked to the Render address is refused on `http://127.0.0.1:8000`; EzWay then shows a notice instead of the map and keeps working. To see the map locally, add `http://127.0.0.1:8000/*` to the key's allowed websites.

About the free plan:

* It sleeps after about 15 minutes without visitors; the next visit takes about a minute to wake up.
* Its CPU is small, so a new walking area takes roughly 15 to 45 seconds to build (downtown Flushing is prepared and opens instantly). Built areas are reused while the service is running, but its disk is not kept across restarts or redeploys.
* Memory use is about 320 MB with five areas loaded, within the free plan's 512 MB.

A paid instance removes the sleep and builds areas faster. Change `plan:` in `render.yaml` or the instance type in the dashboard.

To keep built areas across restarts on another host, mount persistent storage at `/app/data/areas` or set `REST_ROUTE_AREA_CACHE`.

## Installing on an iPhone (Home Screen app)

EzWay is a web app that installs to the Home Screen. No App Store, Xcode or Apple developer account is needed.

1. On the iPhone, open the Render address in **Safari**.
2. Tap **Share** (the square with an arrow), then **Add to Home Screen**, then **Add**.
3. Open EzWay from its icon. It runs full screen with its own icon. "Use my location" asks for permission the first time.

On Android, open the address in Chrome and choose **Add to Home screen** or **Install app**.

Each stretch of a planned walk has a **Google Maps** button. It opens Google Maps walking directions from the phone's current location to the next rest stop (the Google Maps app if installed, otherwise the website). It uses a Maps URL and needs no Google account or API key.

A native App Store app would need Xcode, an Apple developer account for distribution, and a wrapper such as Capacitor around the same frontend. That is not set up.

## Settings

- `REST_ROUTE_GEOCODER_URL`: Photon-compatible endpoint, default `https://photon.komoot.io/api/`. Explicit searches only, limited to New York City, cached, serialized and limited to one request per second in this process. Public Photon is for reasonable small-project use and has no availability guarantee: https://github.com/komoot/photon.
- `REST_ROUTE_AREA_CACHE`: where built areas are saved (default `data/areas`).
- `GOOGLE_MAPS_API_KEY`: the Google Maps browser key (Maps JavaScript API). Read by the server at runtime, so changing it needs no rebuild. Without it the app still plans routes, but shows a notice instead of the map.
- The map's look (colors, and hiding Google's own place, shop and transit icons) is set in code (`LIGHT_MAP` and `DARK_MAP` in `frontend/src/components/MapView.tsx`), so no Google Cloud map style or Map ID is needed.

## Privacy notes

Location requests require HTTPS outside localhost (Render provides it). Access logs should stay disabled because search strings are in query URLs. Application code does not log trip coordinates. Place searches go to Photon; the Google map receives requests for the area being viewed; Google Maps receives a rest stop's location only when its button is tapped. Walking areas are built from local data, so trips are not sent to any map data service. No credentials or trip names are saved in area files.

## Refreshing the NYC data

See README, "NYC data". Run `scripts/update_nyc_data.py`, commit `data/nyc/`, and push; Render redeploys with the new data.
