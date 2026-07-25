# Report — Light Table

## 1. What did you build?

**Light Table** — a mini web app that judges whether an image is AI-generated
or an authentic photo. Repo: https://github.com/dik-garri/detector

You drop, paste, or browse an image onto a glowing "light table"; a scan beam
sweeps it and a needle settles on a photograph↔AI gauge with an evidence
report. Everything runs client-side — no backend, no API keys, no image ever
leaves the machine.

The verdict combines two independent signals:

- **Metadata forensics** — hand-written parsers over the raw file bytes:
  Stable Diffusion / ComfyUI generation recipes in PNG chunks, camera EXIF
  (make, model, exposure — evidence *for* a real capture), the IPTC
  `trainedAlgorithmicMedia` XMP marker embedded by DALL-E and Google Imagen,
  C2PA content credentials, and a whole-file sweep for ~20 generator
  signatures.
- **ML classifier** — a Swin transformer (quantized ONNX, ~88 MB, cached)
  running in the browser via transformers.js.

Hard metadata evidence overrides the classifier; camera EXIF nudges the score
toward authentic; otherwise the classifier decides, with an "Inconclusive"
band in the middle.

| Real photo | AI image (SDXL, metadata stripped) |
|---|---|
| ![Authentic verdict](screenshots/01-authentic-verdict.png) | ![AI verdict](screenshots/02-ai-verdict.png) |

Tested end-to-end in Chrome with four crafted fixtures (in `test-fixtures/`):
a PNG carrying a real Stable Diffusion parameters chunk (→ 98% AI), a genuine
SDXL render with metadata stripped (→ 100% AI via classifier alone), a JPEG
with hand-built Canon EOS R5 EXIF (→ 2% AI), and a bare image with no
metadata at all.

## 2. What did you learn?

- **Metadata is the strongest and the weakest signal at once.** When present,
  an embedded generation recipe or a signed C2PA manifest is near-proof — but
  social networks, screenshots and editors strip it routinely, so for most
  real-world images the ML classifier is the only signal left. A layered
  design (hard evidence overrides, soft evidence nudges, classifier decides)
  handles both worlds.
- **In-browser ML is genuinely practical now.** An 88 MB quantized Swin model
  loads once through transformers.js, is cached by the browser, and
  classifies in well under a second — giving a free privacy guarantee that a
  server-side detector can't match.
- **Provenance standards are further along than expected.** IPTC's
  `trainedAlgorithmicMedia` digital-source-type and C2PA manifests are
  already embedded by major generators; detecting them needs only byte-level
  parsing of PNG chunks, EXIF/TIFF IFDs, and XMP packets.
- **No detector is definitive.** Metadata can be forged or transplanted, and
  classifiers misread edited, upscaled or unusual photos — so the UI presents
  the verdict as an informed opinion with visible evidence rows rather than a
  binary answer.
- **Synthetic fixtures make an "unbuildable-to-test" feature testable.**
  Hand-crafting a PNG with an SD parameters chunk and a JPEG with a
  hand-rolled TIFF/EXIF block made every code path verifiable end-to-end in a
  real browser before any real-world image was tried.
