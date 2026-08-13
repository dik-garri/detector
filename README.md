# Light Table — AI image detector

A mini web app that judges whether an image is AI-generated or an authentic
photo. Everything runs in the browser; no image ever leaves your machine.

## Run

```sh
python3 -m http.server 8642
# open http://localhost:8642
```

Any static file server works — there is no build step and no backend.

## How it decides

Two independent signal sources are combined into one verdict:

1. **Metadata forensics** (`forensics.js`) — parses the file bytes directly:
   - PNG text chunks: Stable Diffusion / A1111 `parameters`, ComfyUI
     `prompt`/`workflow`, InvokeAI and NovelAI signatures
   - JPEG/WebP EXIF: camera make, model and exposure data (evidence *for*
     a real capture), AI generators in the Software tag
   - XMP: the IPTC `trainedAlgorithmicMedia` digital-source-type marker
     embedded by DALL-E, Google Imagen and others
   - C2PA content credentials (presence + AI-generation claims)
   - A whole-file sweep for known generator signatures
2. **ML classifier** — [SMOGY AI-images detector](https://huggingface.co/onnx-community/SMOGY-Ai-images-detector-ONNX)
   (Swin transformer, quantized ONNX, ~88 MB one-time cached download) runs
   in-browser via transformers.js.

Hard metadata evidence (an embedded generation recipe, an AI C2PA claim)
overrides the classifier. Camera EXIF nudges the score toward authentic.
Otherwise the classifier probability decides, with an "Inconclusive" band in
the middle.

## Framing (`framing.js`)

The classifier cannot be fed the raw file, because two measured failure modes
have nothing to do with whether the image is generated:

**Padding flips the answer.** An AI render filling 95% of the frame scored 100%
artificial; the same render with a uniform border at 60% scored 0.01%. Border
colour is irrelevant, and real photos are pushed toward "authentic" too — flat
matting is simply read as "not a generated image". Any uniform border is
therefore cropped away before scoring, which restored all four padded test
cases from ~0% to 100% without turning the padded real photo into a false
positive.

**On composite frames the model is chaotic, not just biased.** Shaving 2px off
every edge of one screenshot moved it from 24% to 59%; 20px took it to 98%.
Clean photos and renders score identically across every crop (spread 0.0%), so
the app scores seven edge-jittered crops and treats a spread above 25 points as
proof that the model has nothing to say. In that case it reports **"Cannot
tell"** with the observed range instead of inventing a number — a screenshot of
an AI image used to come back as a confident "Likely authentic photo".

Screenshots are also flagged in their own right (dimensions matching a common
capture size, or large flat-colour fills indicating interface chrome), because a
screenshot is re-rendered from pixels and cannot carry the provenance metadata
of the image it depicts. Missing generator metadata in a screenshot is expected
and clears nothing.

## Limitations

Screenshot laundering is only partly recoverable: cropping and crop-ensembling
restore the classifier where they can, but metadata destroyed by a screenshot is
gone for good. Metadata can also be forged, and classifiers misread heavily
edited, upscaled or unusual photos. The verdict is an informed opinion, not
proof.

## Test fixtures

`test-fixtures/` contains the specimens used during development:

| file | expected verdict |
|---|---|
| `ai_sd_image.png` | AI — carries a Stable Diffusion `parameters` chunk |
| `ai_no_metadata.jpg` | AI — genuine SDXL render, metadata stripped (classifier-only path) |
| `real_camera_photo.jpg` | authentic — Canon EOS R5 EXIF with exposure data |
| `commons_landscape.jpg` | authentic — Nikon D50 photo from Wikimedia Commons |
| `bare_no_metadata.png` | authentic/inconclusive — no metadata at all |

The framing behaviour above was verified by driving the real page in headless
Chrome over the DevTools protocol across eleven cases: the four metadata and
clean-image paths, both screenshots, four padded AI images, and a padded real
photo as a false-positive control.

---

[All projects →](https://dik-garri.github.io/garry/)
