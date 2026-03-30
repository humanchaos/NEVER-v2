# NEVER v2 — Claude Code Rules

## Project
Next.js app deployed to never-v3.vercel.app. All AI calls run client-side via Gemini Files API directly from the browser. No server functions. No Vercel timeouts.

## Build & Deploy
cd ~/Downloads/Projects/Claude\ Rebuilds\ Never/never-v2
npm run build
npx vercel --prod

## Architecture constraint
All analysis logic lives in src/lib/store.ts. Do not move AI calls server-side under any circumstances.

## Current state
Read HANDOFF.md before touching anything. The next task is documented there with exact line numbers.

## The one gotcha
shiftTc() converts chunk-relative timecodes to absolute. Do not touch this function without understanding the chunking logic above it.