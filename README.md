# 2026 World Cup: Spain are champions

Public, no-login bracket for the 2026 World Cup Final at [worldcup.kobexamoh.me](https://worldcup.kobexamoh.me).

Spain beat Argentina 1-0 in extra time. The Final and third place are locked to the real results. Add your name and screenshot the podium.

## Stack

- Vite + vanilla JavaScript
- localStorage for picks
- html2canvas for PNG export (lazy-loaded)
- Node built-in test runner

## Commands

```bash
npm install
npm run dev      # http://localhost:3000
npm test
npm run build    # output in dist/
```

## Deploy

Static Vite build on Vercel (`vercel.json` rewrites to `index.html`). No backend or env vars required for the public bracket.

Optional: enable [Vercel Web Analytics](https://vercel.com/docs/analytics) in the dashboard. The client calls `@vercel/analytics` on the deployed domain only.

## Tests

Unit tests cover bracket validation, knockout logic, export helpers, and localStorage persistence.
