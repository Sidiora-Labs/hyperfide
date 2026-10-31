## Shipping a theme in a plugin

A plugin can contribute themes via its manifest instead of the theme dir:

```json
"Hyperfide": { "themes": [{ "id": "mine", "name": "Mine", "css": "./themes/mine.css" }] }
```

Hyperfide lists it as `plugin:<pluginId>:mine`. Theme Preview resolves the CSS through
the manifest, so chips and live reload work the same way. Install with
`hyperfide-platform plugin install path:<dir> --yes`, reload with `hyperfide-platform plugin reload <pluginId>`
after CSS edits.
