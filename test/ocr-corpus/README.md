# Screenshot corpus

Real Global English captures the screenshot import is calibrated and tested against. Each one was scanned
once with the real engine and frozen into `fixtures/<name>.json`, which holds what the reader produced, and
`golden/<name>.json` holds the build it makes.
[components/screenshot-ocr/corpus.test.ts](../../components/screenshot-ocr/corpus.test.ts), run by
`npm run test:ocr`, replays the fixtures through `merge.ts` and `build.ts`, compares the result against the
goldens, and compares both against what a person read off the screen.

A fixture is one `scanScreen` run over the decoded image with the offered skill names as the pool. The
reader is not in git, so re-freezing means running `node tools/fetch-ocr-assets.mjs` first, and a JPEG
capture needs a decoded PNG twin outside the repo, since the decoder reads PNG. A fixture replays without
its image.

## The batch

| File | Rows | What it is |
|---|---|---|
| `copano-rickey-eightfold-fortune.png` | 19 of 19 | Details dialog, skills tab, top of the list |
| `grass-wonder-stone-piercing-blue.png` | 19 of 19 | Details dialog, skills tab, top of the list |
| `narita-taishin-nevertheless.png` | 19 of 19 | Details dialog, skills tab, top of the list |
| `oguri-cap-starlight-beat.png` | 21 of 21 | Details dialog, skills tab, top of the list |
| `taiki-shuttle-bubblegum.png` | 17 of 17 | Details dialog, skills tab, inside the dialog |

Naming is `<character>-<outfit epithet>[-<device or rank>]`. Two files of the same horse differ by rank or
scroll position, never by crop.

Two shapes are worth having and this batch has neither yet. A pair of plain screenshots of one dialog, taken
at two scroll positions, has a real overlap, which is the case `merge.ts` has to join. A stitched rolling
capture already merges several viewports into one tall image, so it carries more skill rows than one screen
shows. The implementation used for earlier captures is at
[receipt_factor](https://lt900ed.github.io/receipt_factor/). `merge.test.ts` covers the join until a pair
lands in `images/`.

## What this batch shows

Timings, single-thread wasm on one desktop machine, one capture each over two runs: 2.8 to 5.0 s at 592 to
781 px wide.

Skill names are matched only against the 1340 names this fork offers, each entry's live name, which is index 0
of its array in `skillnames.json`. The 95 rows read across the five captures score 0.94 or better. Nothing
that was not an accepted skill name scores above 0.76, and the strongest of those are halves of wrapped names
(`White Lightning Comin'` at 0.73, `Straightaways ` at 0.76) and the aptitude label `Late` at 0.67. The accept
line at 0.82 sits in that gap.
`matcher.test.ts` pins the misreads that are accepted and the screen text that is refused.

One row waited on the data rather than the reader. Copano Rickey's list shows `Muddy ○`, and the pool used to
take an entry's last name, which for a renamed skill is the retired one: `202342` reads
`["Muddy ◎", "Mud Play ◎"]`, so `Mud Play` was offered and `Muddy` was not. The line itself read at 0.95 all
along. The readers now take index 0, and every row on every screen answers to an offered name.

The tier a marker shows comes from the shape of its glyph, because the reader draws `◎`, `○` and `0` alike. The
two differ by the width of their hole: `◎` is one wide wall around a hole two pixels across, `○` leaves most of
its inside empty (`markers.ts`). 14 rows arrived as a letter and the shape settled all 14, 13 as a single ring
and one with two. The double one is Taiki Shuttle's `Pace Chaser Straightaways 0`, which becomes the `◎` tier
`201311` in the same image where the single ring makes `Tokyo Racecourse O` the `○` tier `200032`. Two rows
arrived as `©`, which the text settles on its own.

Rows whose text lost the marker altogether are measured the same way, since the game always draws one, so each
line is asked for its glyph whether or not its last character looked like a letter. Four rows still reach the
review screen as a choice, because neither their text nor the pixels around their name gave a ring. The
candidates are the two or three tier variants of that name, and the review screen offers them.

Aptitude letters are colours: S 44°, A 25°, B 340°, C 107°, D 205°, E 287°, F 247°, and G carries no colour,
which is how it is told apart. All 50 cells, ten per capture, came out as a person read them, which is what
holds `GRADE_HUES` in place.

The five stat numbers sit in a row under the labels Speed, Stamina, Power, Guts and Wit, and the detector
glues the rank badge to the number in front of it, so one box holds both (`UE1622`, `U 1208`). The row is
read whole, and all 25 cells came out right. The digit-masked ladder runs over the same box as a second
reader, and its own readings disagree with each other on 8 of the 25 cells, so those 8 arrive in the review
screen flagged even though every one of them was correct.

The trained name was read exactly in all five captures. The epithet was read exactly in four: oguri's
`[Starlight Beat]` came out `[Staright Beatl`, losing an `l` and the closing bracket, so an opening bracket
plus the shape is what the outfit lookup works with.

The unique skill's level chip was read in all five (Lvl 6, 5, 5, 4, 3), and that chip is what separates the
character's own copy of a name from the copy another character inherits. Oguri's Triumphant Pulse arrives
with `Lvl 5` and becomes `100061`, while Grass Wonder's row for the same name carries no chip, is the
inherited copy in the inheritance slot, and becomes `900061`.

Long names still wrap onto a second line: `White Lightning Comin' Through!` and `End Closer Straightaways`
arrived split and are accepted whole, and the join only fires when the line above answers to no name, because
two rows stacked in one column would otherwise merge and hide a skill.

Every capture read all five stats and all ten aptitude cells, so `gaps` answers empty for each of them. The
fallbacks in `build.ts` are not what fills these five builds.
