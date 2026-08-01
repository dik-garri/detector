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

## Limitations

Metadata is routinely stripped by social networks and screenshots, and can be
forged. Classifiers misread heavily edited, upscaled or unusual photos. The
verdict is an informed opinion, not proof.

## Test fixtures

`test-fixtures/` contains four specimens used during development:

| file | expected verdict |
|---|---|
| `ai_sd_image.png` | AI — carries a Stable Diffusion `parameters` chunk |
| `ai_no_metadata.jpg` | AI — genuine SDXL render, metadata stripped (classifier-only path) |
| `real_camera_photo.jpg` | authentic — Canon EOS R5 EXIF with exposure data |
| `bare_no_metadata.png` | authentic/inconclusive — no metadata at all |

---

[All projects →](https://dik-garri.github.io/garry/)
