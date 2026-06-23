## 2024-06-23 - Form label accessibility in Info panel

**Learning:** The Info panel uses small textual hints above inputs (like "Display name") implemented as `<div>` elements instead of proper `<label>` elements. This causes screen readers to miss the context of the input fields. Additionally, textareas with placeholders but no visible labels lack `aria-label`s.
**Action:** Always convert visual label `<div>` elements into `<label>` elements with `for` attributes matching the input's `id`, adding `block` utility class to maintain layout. Ensure standalone inputs/textareas have `aria-label` attributes.
