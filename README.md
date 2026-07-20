# Data Recipes

> Working title — the real product name plugs in via [`src/branding.ts`](src/branding.ts).

Turn plain-language descriptions into **reusable data-transformation scripts**. Drop a CSV or Excel file, describe a filter or transformation, and the AI generates a deterministic pandas script that runs instantly in your browser. Save the script as a **recipe** and re-run it on next month's file — same steps, same result, no re-prompting.

**Radically simple by design:** no accounts, no server, no connectors, no projects. A static web page.

## How it works

1. **Drop a file** — CSV/XLSX is parsed by pandas running in your browser via [Pyodide](https://pyodide.org) (WebAssembly). Your data never leaves your machine.
2. **Describe a transformation** — the column schema (and, optionally, 20 sample rows) is sent to the Anthropic API with your own API key. The model returns a Python script defining `transform(df)`.
3. **See the result** — the script runs locally; you get an output preview plus a diff summary (rows in → out, columns added/removed). Iterate conversationally, or edit the script directly.
4. **Save the recipe** — a self-contained `.py` file with a metadata header (your prompts, expected columns) and a CLI entry point. Re-run it in the app by dropping it alongside a new file, or anywhere Python runs:

   ```sh
   python my-recipe.py input.csv -o output.csv
   ```

## Privacy model

- File contents are processed entirely client-side (Pyodide in a web worker).
- The AI request contains column names, types, row count, and — only if enabled in Settings — the first 20 rows.
- Your API key is stored in `localStorage` and sent only to `api.anthropic.com`.

## Development

```sh
npm install
npm run dev     # http://localhost:5173
npm run build   # type-check + production build to dist/
```

Deploys anywhere that serves static files (GitHub Pages, Netlify, …). Pyodide (~15 MB) is fetched from jsDelivr on first use.

## Architecture

| Piece | Where |
|---|---|
| Pyodide runtime + pandas execution | `src/lib/pyodideWorker.ts` (web worker) |
| Worker RPC wrapper | `src/lib/pyodide.ts` |
| Script generation (Anthropic API, browser-direct) | `src/lib/llm.ts` |
| Recipe file format (build/parse `.py`) | `src/lib/recipe.ts` |
| UI | `src/App.tsx` + `src/components/` |
| Product name / tagline | `src/branding.ts` |

## Renaming the product

Set `APP_NAME` and `APP_TAGLINE` in `src/branding.ts`, update `name` in `package.json`, and replace the title of this README. Nothing else references the name.

## License

[MIT](LICENSE)
