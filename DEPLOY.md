# Deploying Rest Route to Vercel

The repository is set up so Vercel can build and host it straight from GitHub. One Vercel project serves both the web page and the API at the same address (`https://<your-project>.vercel.app`).

How it is wired:

* `index.py` (repo root) is the entrypoint Vercel looks for. It loads the FastAPI app from `backend/app/main.py`.
* `pyproject.toml` lists only what the server needs at runtime (FastAPI, Pydantic, Shapely, pyproj) and tells Vercel to build the React frontend (`cd frontend && npm ci && npm run build`).
* `vercel.json` keeps tests, docs, `node_modules` and raw import files out of the server bundle.
* The server only reads files. The Flushing data must be imported on your laptop and committed (step 3).

## 1. Put the code on GitHub

```bash
cd rest-route
git init
git add .
git commit -m "Rest Route"
```

Create an empty repository on github.com (no README), then:

```bash
git remote add origin https://github.com/<you>/rest-route.git
git branch -M main
git push -u origin main
```

`.gitignore` already leaves out `node_modules`, `.venv`, build output and raw download files.

## 2. Create the Vercel project

1. Go to vercel.com, sign in with GitHub.
2. **Add New → Project**, pick the `rest-route` repository, **Import**.
3. Framework Preset should show **FastAPI**. If it shows something else, select FastAPI. Leave Root Directory as the repository root and leave the build settings empty (they come from `pyproject.toml`).
4. **Deploy**. The first build takes a few minutes.
5. Open the URL. The demo mode should work right away. Open `/api/health` to see which data sets are loaded.

## 3. Add the Flushing data

On your laptop (see README, "Importing the Flushing pilot"):

```bash
python scripts/prepare_pilot.py
git add data/pilot data/manifests
git commit -m "Flushing pilot data"
git push
```

Vercel redeploys automatically on every push. After it finishes, the site opens in Flushing mode by default.

## If something goes wrong

* **Build fails**: open the deployment in Vercel, copy the build log, and look at the first error. A failure during `npm ci`/`npm run build` is a frontend build problem; a failure while installing packages is a Python dependency problem.
* **Page loads but says the server can't be reached**: open `/api/health`. If that fails, check the function logs (Vercel project → Logs).
* **Flushing mode says data not available after pushing**: make sure `data/pilot/graph.json.gz`, `matrix.json.gz`, `rest_route.sqlite` and `manifest.json` were committed (`git ls-files data/pilot`).
* **First visit after a while is slow**: serverless functions start on demand; the first request after idle takes a few seconds.

## Alternative: Render (always-on server)

The included `Dockerfile` runs the same app as one persistent server. On render.com: **New → Web Service**, connect the repo, choose Docker, deploy. The free tier sleeps when idle, so the first visit can take up to a minute.

## Notes

* HTTPS is provided by Vercel, which "Use my location" requires.
* Map tiles come from the OpenStreetMap tile server with attribution; set `VITE_TILE_URL` in Vercel's Environment Variables to switch providers.
* Tested before delivery by simulating the Vercel bundle (Python 3.12, only the runtime packages, read-only files, built frontend) and running the API and the browser demo flow against it. The real Vercel build has not been run, since that needs your account.
