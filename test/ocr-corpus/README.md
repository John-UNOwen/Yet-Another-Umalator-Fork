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

## What these files have settled so far

Timings, single-thread WASM on one desktop machine: a stitched capture around 594x1040 reads in about
1.3 s (detect 0.6 s), a 3440x1440 Steam capture in about 2.1 s (detect 1.4 s).

Skill names are matched only against the 1340 names this fork offers. Every skill line read from
these files scored 0.9 to 1.0 and every piece of screen text that is not a skill name scored 0.55 or
worse, so the accept line at 0.82 sits in an empty band rather than on a slope. `matcher.test.ts`
pins the misreads that are accepted and the screen text that is refused.

Aptitude letters are colours, and these are the colours the Global client draws on these files: S 44°,
A 25°, B 340°, C 107°, D 205°, E 287°, F 247°. G carries no colour at all, which is how it is told
apart from the rest. Over the 90 aptitude cells in the nine files the colour answered every one: 49
from a letter the detector had boxed on its own, 8 from the strip just past the value word, and 33
from inside the word's own box. In none of them did the colour disagree with the letter the text
reader saw, and none needed a guess. That agreement is what the reader can check on its own; the
goldens below are still what pins the letters themselves.

