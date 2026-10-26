# Single-container build: the frontend is built, then served by the backend.
# Render builds this file (see render.yaml); it also runs locally with Docker.
FROM node:22-slim AS web
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.13-slim
WORKDIR /app
COPY backend/requirements-server.txt backend/requirements-server.txt
RUN pip install --no-cache-dir -r backend/requirements-server.txt
COPY backend/ backend/
COPY data/ data/
COPY --from=web /app/frontend/dist frontend/dist
WORKDIR /app/backend
EXPOSE 8000
# Hosts such as Render choose the port through $PORT.
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --no-access-log
