# Hyperfide-plugin-composer-customization

A small reference plugin for every `app.composer.customize(...)` region:

- `actions`: a React button using `useComposer()` to lock and decorate the
  bound draft;
- `plusMenu`: a host-rendered command that appends a checklist with
  `insert(…, { at: "end", block: true })`;
- `banners`: a card showing the draft, its mentions, its scope, and why
  submitting is blocked; and
- `richText.effects`: a paint-only rule highlighting `TODO`.

The CSS uses HYPERFIDE's public `--canvas`, `--ink`, and `--accent` theme anchors.
Production plugins should vendor the HYPERFIDE prompt icon-button recipe for action
chrome and keep custom action buttons keyboard accessible.

## Install and try it

Run:

```sh
hyperfide-platform plugin install ./examples/plugins/composer-customization
```

Open any expanded composer, type `TODO`, use the `+` menu command, and activate
the `Polish` action. The action toggles the input lock and whole-draft effect;
activate `Unlock` before submitting. After source edits, run
`hyperfide-platform plugin reload composer-customization`.
