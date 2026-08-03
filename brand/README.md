# brand/

Put the master logo here as `logo.png` — square, 1024px or larger, transparent
background if possible.

Then regenerate every icon and the social preview in one step:

    node scripts/build-icons.mjs

That writes `public/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`,
`apple-touch-icon.png` and `og.png`, and prints what it made.

Generating them rather than hand-exporting keeps the set consistent: replacing
one icon by hand and forgetting the maskable variant leaves the old mark on
some Android launchers and the new one everywhere else.

`logo.png` itself is committed — it's the source of truth the icons derive from.
