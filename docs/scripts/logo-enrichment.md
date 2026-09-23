# Logo enrichment with local AI

`scripts/logos/scrape-website-logos.ts` builds a broad inventory of image, SVG, CSS, and metadata assets from each school's official site. It records each asset's semantic DOM ancestry all the way to the document root, uses local AI to text-rank the inventory, converts the top ranked assets to compressed WebP previews, and asks a local vision-language model to select one official institution or district logo—or decline them all.

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
Invoke-Item .\data\logos\logo-retrieval-review.html
```

The visual page shows the AI's one school-level choice and confidence once, then labels every candidate by its own AI classification (for example, `wordmark · eligible` or `photo · rejected`). It still shows every candidate so selections and declines can be assessed quickly. The detailed manifest retains the original candidate metadata, semantic ancestry, and page region for retrieval debugging.

`data/logos/logo-retrieval-review.html` and `data/logos/logo-retrieval-review.csv` are the first-stage text-ranking audit. They list every discovered DOM asset, its element metadata and semantic ancestry, its batch rank, and whether the text model handed it to visual evaluation. Use them to tell whether a missing logo was never discovered or was excluded by the text-ranking layer. They do not make a claim that an asset is a logo.

The scraper handles structured attributes such as Finalsite's `data-image-sizes` as JSON asset descriptors rather than as `srcset`; the audit therefore links to the actual asset URL. Favicons and web-manifest icons are shown as `deferred_favicon` and do not compete with ordinary assets in text ranking. They are only used as a last-resort visual fallback when no normal page asset reaches visual evaluation.

Responsive CDN renditions of the same versioned source image are collapsed before text ranking, downloading, and visual evaluation. Video and audio assets are discarded during discovery and are also rejected by their response media type as a safeguard.

The review retains transparent WebP previews and displays them on a dark checkerboard so white marks are visible. The local vision model receives a separate dark-composited copy of the same preview; this avoids losing white-on-transparent marks while keeping the stored logo asset transparent.

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

Apply mode is intentionally explicit. It requires active Cloudflare authentication, always requires `--yes`, and refuses to run with `--no-ai`. It does not generate the visual candidate review; use evaluation mode for visual checking. It does retain the local text-retrieval audit for troubleshooting.

## Swapping the AI implementation

The scraper depends on the `LogoSelector` interface in `scripts/logos/logo-selector.ts`, not directly on Ollama. `OllamaLogoSelector` first performs text-only inventory ranking and then sends the short-listed previews in one schema-constrained visual request. A different local runtime or a future hosted selector can replace that class while keeping the scraping, review, and apply workflows unchanged.
