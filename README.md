# 2026 World Cup Final Round Bracket

Public, no-login bracket for the World Cup Final Round at [worldcup.kobexamoh.me](https://worldcup.kobexamoh.me).

Pick Spain vs Argentina in the Final and the third-place match (France vs England). Picks save in your browser; screenshot to share.

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

Optional: enable [Vercel Web Analytics](https://vercel.com/docs/analytics) in the dashboard — the client calls `@vercel/analytics` on the deployed domain only.

## Tests

Unit tests cover bracket validation, knockout logic, export helpers, and localStorage persistence.
