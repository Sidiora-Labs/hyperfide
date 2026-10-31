# Hyperfide asset provenance

The source artwork is the existing repository extension icon:
`editors/vscode/media/icon.png` and `editors/vscode/media/icon.svg`.
No external artwork or image generation service was used.

The PNG source SHA-256 is `f7c4ff683bad79cd8e5aade1140a4d1e195d7335e1d8ad9ea4604e099c467c6e`.

`hyperfide-logo.png` and `hyperfide-logo.svg` are exact copies of those sources.
Existing logo paths in this directory retain their filenames for source imports;
their contents now carry the extension artwork. Unrelated screenshots and CI
illustrations remain documentation illustrations, not product identity assets.

All PNG icons in `apps/app/public`, `apps/desktop/assets`, and
`apps/mobile/assets` were resized from the PNG source with the workspace's
existing sharp 0.34.5. Each keeps its original pixel dimensions and path.
Artwork is centered with transparent padding. Mobile light and development app
icons are flattened onto white for the iOS opaque-icon contract; monochrome and notification icons
use white artwork with the source alpha mask. Existing color and development
variant paths currently use the same Hyperfide artwork.

Desktop ICNS files contain PNG representations at 16, 32, 64, 128, 256, 512,
and 1024 pixels, generated from the same source. Mobile splash images use the
same centered artwork. The old filenames remain until their source references
can be migrated together.
