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

The five stat numbers sit in a row under the labels Speed, Stamina, Power, Guts and Wit, and the
detector glues the rank badge to the number in front of it, so one box holds both. Over the 45 cells in
the nine files, cutting the badge out of the crop by colour failed: some of these files draw the digits
in colour themselves, and the strip behind a number carries two backgrounds, so no single colour is the
panel. Splitting the crop on ink gaps failed too, because the gap between two digits of one number can
reach 11 px while the badge sits 16 px away. What works is reading the row whole: the badge is drawn as
a letter, so the unmasked reading keeps it apart from the digits ("U 1321"), and a run too long to be a
stat says which side the extra digit came from ("U81230" is 1230). The digit-masked ladder runs over the
same box as a second reader and agrees on 34 of the 45 cells. Against the 30 cells whose value was read
off the screenshot by hand, every one came out right, with none wrong and none unanswered.

Two things about this row are only true of these files. A short label often arrives with one or two
glyphs glued to its front ("yGuts", ". Power"), so a label is matched on the end of its last word. And
a number sits under its own label rather than inside its region: on two of these files the next
column's wider box reaches back into the region, and only distance to the label middle refuses it.

