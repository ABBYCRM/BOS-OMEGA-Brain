# Deploy llm-gateway

The code is in `/workspace/llm-gateway/`. Pick the path that works for you.

## Option A: One-click Render Blueprint (fastest)
1. Push this directory to a new GitHub repo (e.g. `ABBYCRM/llm-gateway`).
2. In Render dashboard: New → Blueprint → point at the repo.
3. Render reads `render.yaml` and creates the service.
4. Once live, set `OPENAI_API_KEY` env var in Render dashboard.
5. Hit `https://<service>.onrender.com/audit` to verify.

## Option B: Render web service from existing GitHub
1. Push to GitHub.
2. New → Web Service → pick the repo.
3. Build: `npm install`. Start: `node server.js`. Plan: Starter. Disk: 1GB at /var/data/llm-gateway.
4. Health check path: `/healthz`.

## Option C: Run anywhere Node 18+
```bash
tar -xzf llm-gateway.tar.gz
cd llm-gateway
npm install
OPENAI_API_KEY=sk-... node server.js
```
Then `curl http://localhost:10000/audit` returns the report.

## Option D: Plug into an existing app
Just import `lib/client.js` and set `baseURL` to your gateway. Or change your
existing OpenAI SDK's `baseURL` to `https://<your-gateway>/v1`.
