# Tailwind conversion recipe (ticket #3071)

Established converting `mui-{button,input,checkbox,text,badge,divider,spinner}`. Later tasks follow this, not re-derive it.

## Token → utility table

| Token source                                            | Utility                                                                                                                                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$maple-color-*`                                        | `bg-*`/`text-*`/`border-*` — matches `--color-*` 1:1                                                                                                                             |
| `$maple-spacing-{xs,sm,md,lg}` (4/8/16/24px)            | numeric spacing utils (`1`/`2`/`4`/`6`) — Tailwind's 4px step lines up by **coincidence**, not registration (spacing isn't in `@theme`); doesn't generalize past 4/8/16/24/32/48 |
| `$maple-radius-*` (4/6/8/12/16/24/9999px)               | `rounded-{sm,md,lg,xl,2xl,3xl,full}` — same coincidence caveat                                                                                                                   |
| `--text-{source-title,sheet-title,value-chip,filename}` | bundled `text-<name>` (has font-family via tokens.scss `@utility`)                                                                                                               |
| other 5 `--text-*` variants                             | `text-<name>` + explicit `font-sans` (theme namespace can't carry `--font-family`)                                                                                               |
| one-off non-token values                                | arbitrary values (`text-[13px]`), never rounded to a "close" utility                                                                                                             |
| `color-mix()`/`rgba()` one-offs                         | arbitrary value, `_` for spaces: `bg-[color-mix(in_srgb,var(--color-warn)_30%,transparent)]`                                                                                     |

## Variant-class decision rule

- **One mutually-exclusive computed string per shared CSS property**, not one utility per state. When two states share a property and the original SCSS decided the winner by declaration order (e.g. `.is-error` after `.is-focused`), don't reproduce it with two conditional utilities of equal specificity — Tailwind's generated order isn't a template-level guarantee. Write one `computed()` resolving the precedence in JS, returning only the winning classes. This applies even to a single add-on like `disabled:opacity-45` layered over a base `cursor-pointer` — fold both branches into one computed too, never base-class-plus-conditional-add-on.
- Prefer a built-in state variant (`disabled:`, `enabled:hover:`, `peer-focus-visible:`) over a computed string when Tailwind already expresses the condition natively.
- Marker classes (`variant-x`, `is-active`, …) stay bare and style-free wherever a `.spec.ts` asserts on them or an external `::ng-deep` selector targets them — grep every class before deleting it.

## Residue rules

Only: `@keyframes` (referenced via arbitrary `[animation:...]`, names are global) and pseudo-elements with `content` + absolute geometry (44×44 hit targets). Sibling-focus rings use `peer`/`peer-focus-visible:` instead of residue.

## Host-class rule

Unconditional `:host { display: X }` → `host: { class: 'X' }`. A conditional `:host` block becomes one computed `host: { '[class]': fn }` returning the whole mutually-exclusive set — never a static class plus a conditional add-on.

## Gotcha: bare `text-{xs,sm,base}` also sets line-height

Bare `text-{xs,sm,base}` also sets `line-height`, not just `font-size` — pair it with an explicit `leading-*` or use `text-[Npx]` instead when the original rule only specified a font size. (A follow-up sweep to audit existing usages is tracked separately — don't do that sweep here.)
