# Abracadata — brand marks

The logo is the **Framed Spark Grid**: a rounded tile of violet data cells, one
turned to a gold spark. Brand colors — violet `#6A2CD4` (light) / `#A685FF`
(dark), antique gold `#C47D10` / `#F2B53D`.

## Files
- `mark-light.*` — mark for light backgrounds (violet + antique gold, transparent)
- `mark-dark.*` — mark for dark backgrounds (luminous violet + gold, transparent)
- `mark-tile.*` — solid violet tile (drop on any background); also the app icon/favicon
- `mark-tile-square.*` — full-bleed square tile (social avatars, iOS)
- `lockup-{light,dark}.*` — full logo (mark + wordmark, Hanken Grotesk 800)
- `*-outlined.svg` — lockups with text converted to paths (no font needed)

`.svg` is the source of truth (vector, infinite resolution). PNGs are provided at
256/512/1024 (marks) and 920/1840 wide (lockups).

## Regenerate any size
SVG → PNG with Inkscape (used to build this pack):
```sh
inkscape mark-tile.svg --export-type=png --export-filename=mark-tile-2048.png -w 2048 -h 2048
```
The wordmark needs Hanken Grotesk installed, or use the `*-outlined.svg` (fonts baked in).
