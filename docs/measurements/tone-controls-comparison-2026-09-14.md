# Tone controls: Maple, darktable and RawTherapee

This comparison uses the projects' public manuals and measured Maple/ACR renders.
It does not incorporate GPL implementation code. The controls are not numerical
substitutes for one another: an Adobe `Whites2012` value cannot be copied into a
filmic white-exposure setting and expected to produce the same image.

| Concern               | Documented behaviour                                                                                                                                                          | Implication for Maple                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Exposure              | RawTherapee expresses exposure compensation in stops and describes its effect across the histogram.                                                                           | Keep the scene-linear `2^EV` multiplier. A fixed stop change does not imply a fixed change in displayed L\*.                                                       |
| White point           | darktable filmic places scene white in EV relative to middle gray and maps it to display white. Its picker measures the selected region; it is not an ACR-response predictor. | Whites needs useful control over the image's upper tonal range. Matching an ACR-derived surrogate does not establish that Maple's actual render behaves correctly. |
| Highlight compression | RawTherapee distinguishes compressing available highlight data from reconstructing sensor-clipped data, and exposes where compression begins.                                 | Test the slider response separately from RAW recovery. A sensor-ceiling correction can expose a view-transform defect that the old recovery mask concealed.        |
| Highlight colour      | darktable documents gamut handling and highlight saturation as part of the tone mapper.                                                                                       | Preserving RGB ratios is not sufficient to make bright colours approach display white. The brightness norm and gamut mapping must work together.                   |

Sources: [darktable filmic RGB manual](https://docs.darktable.org/usermanual/development/en/module-reference/processing-modules/filmic-rgb/)
and [RawTherapee Exposure manual](https://rawpedia.rawtherapee.com/Exposure), accessed
2026-09-14.

Maple's measured Exposure response does not justify a blanket reduction: genuine
ACR ±1 EV comparisons show similar or weaker whole-image response on the two
suspected outliers. See the committed `test-fixtures/tone-exposure/` corpus.

The Whites work exposed a separate limitation of Maple's maximum-channel AgX
normalization: bright saturated colours can stay dark and chromatic after tone
mapping. Alternative brightness norms are under native colour-budget evaluation;
none is accepted merely because it resembles another application's design.
