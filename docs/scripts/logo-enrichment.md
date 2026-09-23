# Logo enrichment with local AI

`scripts/logos/scrape-website-logos.ts` discovers likely logo assets from each school's official site, converts up to five candidates to compressed WebP previews, and asks a local vision-language model to select one official institution or district logo—or decline them all.

The script has two modes:

- **Evaluation mode** is the default. It reads local D1 only and writes previews, a detailed manifest, a compact CSV, and a visual HTML review under `data/logos`. It never writes D1 or R2.
- **Apply mode** requires `--apply --yes`. It uploads only AI-approved candidates to remote R2 and writes the corresponding remote D1 `logo_key`. Candidates below the confidence threshold, model rejections, and model errors stay `NULL`.

## One-time local model setup

The default model is `qwen3-vl:4b`, selected for this computer's 6 GB RTX 4050 GPU. Ollama stores its models outside this repository at `C:\Users\<your-user>\.ollama\models` unless `OLLAMA_MODELS` is configured.

Install Ollama for Windows from [ollama.com](https://ollama.com/download/windows), then open a new PowerShell window and download the model:

```powershell
ollama pull qwen3-vl:4b
ollama list
```

Ollama normally starts as a local background service at `http://127.0.0.1:11434`. Verify the model is loaded after the first script run:

```powershell
ollama ps
```

The script requests a 30-minute keep-alive so repeated schools do not reload the model. The default AI queue concurrency is one; retain it for a 6 GB GPU.

## Evaluation run

From the repository root, reset prior local evaluation artifacts, evaluate a random balanced sample of 20 schools, and open the visual review:

```powershell
npm run logos:scrape -- --reset-review --yes
npm run logos:scrape -- --limit 20 --concurrency 8 --seed logo-eval-001
Invoke-Item .\data\logos\logo-review.html
```

The visual page shows the AI's one school-level choice and confidence once, then labels every candidate by its own AI classification (for example, `wordmark · eligible` or `photo · rejected`). It still shows every candidate so selections and declines can be assessed quickly.

`--seed` makes the random, category-balanced sample reproducible. If it is omitted, the script prints a generated seed; reuse that value with `--seed <value>` to recreate the same sample against the same local D1 state.

Useful evaluation options:

```powershell
# Run deterministic ranking only, without calling Ollama.
npm run logos:scrape -- --limit 20 --no-ai

# Be more conservative or test a different installed Ollama vision model.
npm run logos:scrape -- --limit 50 --ai-threshold 0.85
npm run logos:scrape -- --limit 20 --ai-model qwen3-vl:2b-instruct

# Reproduce a prior sample.
npm run logos:scrape -- --limit 20 --seed logo-eval-001

# Recreate review files from the retained local manifest.
npm run logos:scrape -- --render-review
```

`data/logos/logo-manifest.csv` retains the run seed, technical candidate details, and the AI model, choice, confidence, response, duration, and status. `data/logos/logo-review.csv` is intentionally compact. Neither directory nor any model file should be committed.

## Apply run

Only run this after reviewing a representative evaluation batch. This command processes the selected schools, uploads AI-approved WebPs to `nukleio-catalog-assets`, and updates remote D1 entries only when `logo_key` is still empty:

```powershell
npm run logos:scrape -- --limit 6000 --concurrency 24 --apply --yes
```

The remote object key is deterministic:

```text
education/colleges/<institution-id>.webp
education/high-schools/<institution-id>.webp
```

Apply mode is intentionally explicit. It requires active Cloudflare authentication, always requires `--yes`, and refuses to run with `--no-ai`. It does not generate the HTML review; use evaluation mode for visual checking.

## Swapping the AI implementation

The scraper depends on the `LogoSelector` interface in `scripts/logos/logo-selector.ts`, not directly on Ollama. `OllamaLogoSelector` sends all candidate previews for a school in one schema-constrained chat request. A different local runtime or a future hosted selector can replace that class while keeping the scraping, review, and apply workflows unchanged.
