See a custom theme on real hyperfide platform screens before you commit to it, and find contrast problems while you still edit the file.

## What you get

- A **Theme Preview** panel in the sidebar with a theme dropdown and a light or dark switch.
- Mock **Thread**, **Split**, and **Settings** screens painted with the selected theme.
- **Overlays** and **Components** sections with dialogs, menus, buttons, inputs, and status chips.
- A **Style sheet** that lists each resolved token with its value and a WCAG contrast ratio against the surface it sits on.
- A live reload. While the panel is open, each save of the active theme file repaints the app and the preview.

## How it works

The panel reads the theme catalog from hyperfide platform and from installed plugins that ship themes. Choose a theme in the dropdown to activate it app-wide. Contrast rows are measurements for guidance. The plugin never creates, edits, or repairs a theme file.

## For agents

The bundled `hyperfide-theme-authoring` skill explains the theme file layout, the token groups, and the checks to run. Agents use the built-in `hyperfide platform theme dir`, `hyperfide platform theme list`, `hyperfide platform theme set`, and `hyperfide platform theme show` commands. Work in a split: the agent edits `theme.css` on one side and you watch the preview on the other.
