# Accessible HTML reports

`diff --format html` is a self-contained, keyboard-usable review artifact. The
report keeps the visual summary and evidence in semantic tables, and each
change category is a native `details` disclosure that remains usable without
script or a pointer device.

The report provides:

- a skip link, a focusable main landmark, and an ordered internal section
  navigation list;
- visible `role="status"` text with `aria-live="polite"` for the revision
  counts and current review state;
- table captions, column headers, row headers, and focusable overflow regions
  for summary and evidence indexes;
- internal evidence links from changed edges and diagnostics to their rendered
  evidence records;
- visible `:focus-visible` outlines and no positive `tabindex` values, so the
  document order is the keyboard focus order; and
- a `prefers-reduced-motion: reduce` rule that disables transitions, animation,
  and smooth scrolling if a future presentation adds motion.

The report remains offline and source-free. Its restrictive CSP allows only
inline styles; it has no scripts, images, external stylesheets, or external
links. Repository-controlled text is HTML-escaped before rendering.

Run the automated accessibility gate with:

```sh
npm run accessibility:validate
```

The checked-in
[`accessibility/scenario.v0.1.json`](../test/fixtures/accessibility/scenario.v0.1.json)
fixture is a manual-review worksheet as well as an automated fixture. It
contains a changed node, an added diagnostic with remediation, and evidence
records. Reviewers should confirm that each remains visible, that the evidence
links land on the evidence table rows, that disclosures open and close with
Enter or Space, that Tab follows the internal navigation and document order,
and that the report remains understandable with motion reduction enabled.
