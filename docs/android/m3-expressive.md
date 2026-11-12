---
tags: [android, design]
---

# Material 3 Expressive in the Android app

A working reference for design threads. It is written from Google's public Expressive material and
the Compose release notes, not from a copy of m3.material.io (which wasn't readable when this was
written). Before relying on a specific API, check it against the pinned versions in
`app/gradle/libs.versions.toml` (Compose BOM 2026.02.01 at the time of writing; material3 1.4.0 is
the latest stable, 1.5.0 is in release candidate).
Many expressive APIs need `@OptIn(ExperimentalMaterial3ExpressiveApi::class)`.

## What "expressive" means

- **Motion is spring physics.** Spatial motion (position, size, shape) uses springs that can
  overshoot slightly; effects motion (color, alpha) uses springs without overshoot. In Compose this is
  `MaterialTheme.motionScheme`, with `MotionScheme.expressive()` (bouncier) or `standard()`.
  Use `fastSpatialSpec()`, `defaultSpatialSpec()`, `slowSpatialSpec()` and the `...EffectsSpec()`
  counterparts instead of hand-tuned tweens.
- **Shape is a tool.** Wider range of corner radii, and shapes that morph on state changes
  (pressed, selected, checked). `MaterialShapes` provides a set of polygons (Pill, Cookie,
  Clover, Sunny and others); `RoundedPolygon.toShape()` makes one usable as a Compose `Shape`.
- **Color carries emphasis.** Use the primary / tertiary containers on the one or two things that
  matter on a screen, not everywhere. Larger color-filled areas are fine.
- **Type gets bolder.** Use heavier weights and bigger sizes for hierarchy; the emphasized type
  styles exist for this. Variable fonts (Figtree, Bricolage Grotesque here) suit it.
- **Size signals importance.** Bigger touch targets and containers for primary actions.
- **Hierarchy through containment.** Group with containers (surface container levels) instead of
  dividers.

## Compose mapping

| Idea | API |
| --- | --- |
| Theme with expressive defaults | `MaterialExpressiveTheme(colorScheme, motionScheme, shapes, typography)` |
| Motion tokens | `MaterialTheme.motionScheme` |
| Shape set and morphing | `MaterialShapes`, `toShape()`, `Shapes` |
| Button groups, toggle and split buttons | `ButtonGroup`, `ToggleButton`, `SplitButton` |
| Floating toolbar | `HorizontalFloatingToolbar`, `VerticalFloatingToolbar` |
| Progress | `LoadingIndicator`, wavy progress indicators |
| Lists | expressive list items (stable from material3 1.5.0-alpha23) |

Which of these are stable differs by version; confirm against the
[release notes](https://developer.android.com/jetpack/androidx/releases/compose-material3).

## How this app fits

- `ui/theme/Theme.kt` maps the Alongside palette (ink, lavender, peach, lime) into a Material
  color scheme but most components read `LocalColors` directly, so a Material theme change alone
  barely shows. Components have to adopt shapes and motion one at a time.
- `AlongsideTheme(expressive = true)` wraps `MaterialExpressiveTheme` with
  `MotionScheme.expressive()`. The app leaves it off. It exists for previews.
- The pebble shape and the lime check are already expressive in spirit. Expect the best wins from
  motion (spring on complete, press feedback) and shape morphing, not from re-skinning.

## Widgets (Glance)

Glance renders to RemoteViews. It supports color, corner radius and typography but not springs,
shape morphing or the new components. Carry the palette, type weight and corner language into the
widgets; don't expect motion.

## Experiment loop

1. Open `ui/experiments/ExpressivePreviews.kt` in Android Studio (Split view). "Current" and
   "Expressive theme" show the real `TaskRow` list side by side, and "Spring check" is a single
   control with shape morph and a spring.
2. Change one variant at a time. Use the preview's Interactive mode to feel motion.
3. When a variant wins, move it into the real component and keep the preview as the record.
4. Screenshots for review can come from Studio's preview or a device; the cloud sandbox can't
   render Compose.
