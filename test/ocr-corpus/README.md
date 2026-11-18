# Screenshot corpus

Real Global English captures the screenshot import is calibrated and tested against. Each file will
carry a golden JSON of the same name, holding what a correct read must produce, as
[docs/ocr-import-plan.md](../../docs/ocr-import-plan.md) describes.

| File | Where it came from | Screen |
|---|---|---|
| `taiki-shuttle-bubblegum-ug9.png` | stitched rolling capture | details, skills tab, scrolled |
| `taiki-shuttle-bubblegum-ug7.png` | stitched rolling capture | details, skills tab, top |
| `taiki-shuttle-bubblegum-ss.png` | stitched rolling capture | details, skills tab, dialog |
| `oguri-cap-starlight-beat.png` | stitched rolling capture | details, skills tab, dialog |
| `symboli-rudolf-archer-by-moonlight.png` | stitched rolling capture | details, skills tab, dialog |
| `taiki-shuttle-bubblegum-steam-top.png` / `-scrolled.png` | Steam client, 3440x1440 | same horse, two scroll positions |
| `daiwa-scarlet-peak-blue-steam-top.png` / `-scrolled.png` | Steam client, 1920x1080 | same horse, two scroll positions |

The stitched captures come from a rolling screenshot implementation and from
[receipt_factor](https://lt900ed.github.io/receipt_factor/). They already merge several viewports
into one tall image, so they carry more skill rows than one screen shows. The Steam pairs are plain
screenshots with a real overlap between them, which is the case `merge.ts` has to join.

The four Steam files are kept as the JPEG the client produced. Tests read PNG, so a decoded twin
goes outside the repo when a run needs one.

Naming is `<character>-<outfit epithet>[-<device or rank>]`. Two files of the same horse differ by
rank or scroll position, never by crop.
