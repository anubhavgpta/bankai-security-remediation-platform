# Bankai — Vulnerability Remediation Platform

A security tool that ingests raw vulnerability scan output and drives it through an automated triage-to-ticketing pipeline.

## Structure

```
.
├── frontend/           React + Vite + TypeScript app
├── backend/             Express + TypeScript API (Supabase auth, Arcjet-protected)
├── deploy/
│   ├── Dockerfile      Multi-stage build → static bundle served by nginx
│   └── nginx.conf      SPA routing + reverse proxy of /api to the backend
├── docker-compose.yml  Local prod-like run (frontend on :8080, backend behind it)
├── .github/workflows/  CI build (frontend build, backend typecheck + build)
└── .env.example        Copy to frontend/.env for VITE_API_BASE_URL
```

## Local development

Frontend and backend run as separate dev servers locally (see
[backend/README.md](backend/README.md) for backend setup, including required Supabase
and Arcjet credentials):

```bash
cd backend
npm install
cp .env.example .env   # fill in Supabase + Arcjet credentials
npm run dev             # http://localhost:4000

cd ../frontend
npm install
npm run dev             # http://localhost:5173
```

## Production build

```bash
cd frontend && npm install && npm run build   # outputs frontend/dist
cd ../backend && npm install && npm run build  # outputs backend/dist
```

## Run via Docker

```bash
SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... ARCJET_KEY=... \
  docker compose up --build
# frontend (and /api, reverse-proxied to the backend) at http://localhost:8080
```

## Status

The frontend currently implements: Login, Sign Up, Projects, New Project (full), and a
persistent Workspace shell (sidebar + routing) with placeholder pages for Remediation
Workflow, Overview, Report Intake, AI Triage, Tickets, Activity, and Settings.

The backend implements sign up / sign in / sign out / session refresh against Supabase
Auth, protected by Arcjet (bot detection, rate limiting, email validation, WAF) — see
[backend/README.md](backend/README.md) for details. Everything past auth (projects,
scan ingestion, triage, tickets) is still local frontend component state.
