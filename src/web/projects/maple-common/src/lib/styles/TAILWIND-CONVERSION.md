# Tailwind conversion recipe (ticket #3071)

Established while converting `mui-{button,input,checkbox,text,badge,divider,spinner}`.
Later tasks should follow this, not re-derive it.

## Token → utility table (actually used)

| Token source                                                                                                                                             | Utility                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `$maple-color-*` (bg, surface, border, primary, primary-dim, text-main, text-muted, warn, star, error-text, error-bg, success-text, border-hi, input-bg) | `bg-*` / `text-*` / `border-*` — theme names match `--color-*` 1:1                                                                                                                                                                                                                   |
| `$maple-spacing-{xs,sm,md,lg}` (4/8/16/24px)                                                                                                             | `1`/`2`/`4`/`6` in any spacing utility (`p-`, `gap-`, `m-`) — Tailwind's default 0.25rem step lines up exactly; **not** registered in `@theme`, so this is a numeric coincidence, not a named token match — don't assume it holds for spacing values outside 4/8/16/24/32/48         |
| `$maple-radius-{xs,sm,md,lg,xl,xxl,full}` (4/6/8/12/16/24/9999px)                                                                                        | `rounded-sm`/`rounded-md`/`rounded-lg`/`rounded-xl`/`rounded-2xl`/`rounded-3xl`/`rounded-full` — same "coincides with Tailwind's default scale" caveat                                                                                                                               |
| `--text-{source-title,sheet-title,row-label,body,tool-label,chip-label,eyebrow,value-chip,filename}`                                                     | `text-<name>` (size/line-height/weight from `@theme`); **font-family is NOT included** except for the 4 variants with a dedicated `@utility text-*` block in tokens.scss (source-title, sheet-title, value-chip, filename) — the other 5 need `font-sans` added explicitly alongside |
| one-off non-token values (13px button label, 44px hit target, etc.)                                                                                      | Tailwind arbitrary values, e.g. `text-[13px]`, `w-[14px]` — never rounded to a "close" named utility                                                                                                                                                                                 |
| `color-mix(...)` / `rgba(...)` one-offs                                                                                                                  | arbitrary value with `_` for spaces: `bg-[color-mix(in_srgb,var(--color-warn)_30%,transparent)]`                                                                                                                                                                                     |

## Variant-class decision rule

Two axes were used, per the constraints' (a)/(b) split — but nearly every
pilot component needed a **third, JS-computed** approach the constraints
implied but didn't name outright:

- **(a) inline computed strings, one per state-machine, not one per CSS property.**
  When two states can share a CSS property and the original SCSS decided the
  winner by _declaration order_ (e.g. `.is-error` declared after `.is-focused`
  so error always wins the border color when both apply), do NOT reproduce
  that with two competing conditional utility classes — Tailwind's generated
  stylesheet order for two classes of equal specificity is not something a
  template should depend on. Instead write one `computed()` in the component
  that resolves the precedence in JS and returns a single string containing
  only the winning utility. Used for: button's `paddingClasses`/`colorClasses`/
  `layoutClasses`, input's `fieldClasses`, text's `displayClasses`.
- **(b) small residue class** — reserved for cases actually requiring raw
  CSS (see below), not for ordinary variant fan-out.
- Marker classes (`variant-x`, `size-x`, `is-active`, …) are **kept verbatim**
  as bare, style-free classes alongside the computed utility classes whenever
  a `.spec.ts` asserts on them via `className.toContain(...)` or an external
  component's SCSS deep-overrides the mui component's class (grep every class
  name before deleting it — several `mui-button`/`.mui-button` selectors are
  overridden from `imports.component.scss`, `people.component.scss`,
  `workers.component.scss` via `::ng-deep button.mui-button {...}`; those
  still win because the compiled `::ng-deep` selector carries an extra
  attribute-selector specificity over a bare utility class).

## Residue rules

Kept as small component SCSS files, nothing else:

- `@keyframes` (button spinner, spinner ring/appear) — referenced from the
  template via arbitrary `[animation:name_duration_timing_iteration]`
  utilities; keyframe names are global regardless of which file declares them.
- Pseudo-elements with `content` + absolute geometry (button/checkbox 44×44
  hit-target `::before`) — Tailwind's `before:` variant can express simple
  cases but a `content: ''` + `inset: 50%` + `transform: translate(-50%,-50%)`
  centered pad reads far worse as an inline utility soup than as 6 lines of
  plain CSS.
- Sibling/peer focus rings (`input:focus-visible ~ .mark`) were **not** kept
  as residue — Tailwind's built-in `peer`/`peer-focus-visible:` variants
  handle this natively (add `peer` to the trigger, `peer-focus-visible:*` to
  the target), so prefer that over residue when the relationship is a plain
  sibling combinator.

## Host-class rule

A `:host { display: X; }` block that's **unconditional** moves to
`host: { class: 'X' }` in the decorator (`inline-flex` for button pre-fullWidth,
`block` for input, `inline-flex` for checkbox/badge/spinner, `contents` for
divider). A `:host` block with a conditional branch (`&.is-full-width {...}`)
does **not** split into a static host class + a conditional `[class.x]` —
same equal-specificity race as above — it becomes one `host: { '[class]':
'computed()' }` returning the whole mutually-exclusive class set (button's
`hostClasses`).
