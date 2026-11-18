# Screenshot corpus

Real Global English captures the screenshot import is calibrated and tested against. Each one was scanned
once with the real engine and frozen into `fixtures/<name>.json`, which holds what the reader produced.
`golden/<group>.json` holds the build a group of captures makes, and
[components/screenshot-ocr/corpus.test.ts](../../components/screenshot-ocr/corpus.test.ts), run by
`npm run test:ocr`, replays the fixtures through `merge.ts` and `build.ts` and compares against it, as
[docs/ocr-import-plan.md](../../docs/ocr-import-plan.md) describes.

A group is one uma: the two Steam shots of one dialog together, or a single capture. The Steam pairs are
the case `merge.ts` has to join, so they are frozen as one build.

A fixture is one `scanScreen` run over the decoded image with the offered skill names as the pool. The
reader is not in git, so re-freezing means running `node tools/fetch-ocr-assets.mjs` first, and a Steam
JPEG needs a decoded PNG twin outside the repo.

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
reader saw, and none needed a guess. That agreement is what the reader can check on its own. The
goldens below are still what pins the letters themselves.

The five stat numbers sit in a row under the labels Speed, Stamina, Power, Guts and Wit, and the
detector glues the rank badge to the number in front of it, so one box holds both. Over the 45 cells in
the nine files, cutting the badge out of the crop by colour failed: some of these files draw the digits
in colour themselves, and the strip behind a number carries two backgrounds, so no single colour is the
panel. Splitting the crop on ink gaps failed too, because the gap between two digits of one number can
reach 11 px while the badge sits 16 px away. What works is reading the row whole: the badge is drawn as
a letter, so the unmasked reading keeps it apart from the digits ("U 1321"), and a run too long to be a
stat says which side the extra digit came from ("U81230" is 1230). The digit-masked ladder runs over the
same box as a second reader, and counting the line's own text among its readings the two agree on 34 of
the 45 cells. The flag the app shows compares the ladder's own readings, which is the stricter of the
two. Against the 30 cells whose value was read off the screenshot by hand, every one came out right, with
none wrong and none unanswered.

Two things about this row are only true of these files. A short label often arrives with one or two
glyphs glued to its front ("yGuts", ". Power"), so a label is matched on the end of its last word. And
a number sits under its own label rather than inside its region: on two of these files the next
column's wider box reaches back into the region, and only distance to the label middle refuses it.


The skill list is the lines that answer to a name the fork offers, so nothing has to know where the
table sits. Every line of every capture was tried against the 1340 offered names, each entry's display
name: 143 lines answered, 13 to 19 per capture. The icons, the `Lvl 4` chips, the stat labels and the
stat numbers answer to no name, so no line of the screen other than a skill name was ever accepted. Two
to seven rows per capture stay a choice for the user, all of them acquisition markers read as a letter or
lost. Only oguri and the taiki Steam top have their lists written down by hand, in `corpus.test.ts`, so
only those two carry the claim that nothing was accepted that should not have been: oguri came out at its
17 names and taiki Steam top at its 14, with nothing missing and nothing extra.

Four things this row only shows on these files. Long names wrap onto a second line, and seven of nine
captures needed the join: `Pace Chaser Straightaways` arrived as `Pace Chaser` over `Straightaways`, and
neither half answers on its own. The join only happens when the line above answers to no name, because
two rows stacked in one column otherwise merge into one and hide a skill. The epithet and the trained
name under it were found in all nine, and one of them lost its closing bracket (`[Archer by Moonlightd`),
so an opening bracket is enough and the epithet goes to fuzzy matching. The unique skill's level was found
on seven of nine, the two scrolled Steam shots showing no chip, and it sits 72 px past its name at height
29 on the phone capture and 88 px at height 30 on the 3440 wide one, so which name a chip belongs to is
settled by nothing intruding between them rather than by a fixed reach. That level is what tells the
character's own skill from the copy another character inherits under the same name: Triumphant Pulse
`100061` rather than `900061`, Joyful Voyage! `110101` rather than `910101`, Red Ace `10091` rather than
`90091`.

Two of the nine carry Triumphant Pulse with no chip at all, and both are the inherited copy in the
inheritance slot, `900061`. On oguri's own screen the same name arrives with `Lvl 4` and comes out `100061`.

Every one of the nine read all five stats and all ten aptitude cells, so `gaps` answers empty for each of
them. The fallbacks in `build.ts` are not what fills these nine builds.
