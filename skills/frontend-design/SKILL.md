---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications (examples include websites, landing pages, dashboards, React components, HTML/CSS layouts, or when styling/beautifying any web UI). Generates creative, polished code and UI design that avoids generic AI aesthetics.
license: Complete terms in LICENSE.txt
---

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

## Shared content and approval workflow

Before creating or substantially redesigning an artifact, read the configured `design-writing.md` (on this Codex setup: `%USERPROFILE%/.codex/guidance/design-writing.md`). It owns audience, reference research, representative samples, approval and reader-facing language; this skill owns frontend implementation. If no such local guide is configured, apply those steps here without treating a missing optional guide as a blocker. Reuse an approved template or reference for small edits instead of reopening style selection. Use working prototypes for interaction and responsive states; generated mockups do not prove implementation quality. If `web-visual.md` is configured, follow it for final rendering checks; otherwise use the available tools to inspect the actual target page, including desktop and mobile layouts.

## Design Thinking

Before coding, understand the context and choose a deliberate aesthetic direction. Existing brand requirements, accessibility, the audience and approved samples govern the choice; expressive novelty is appropriate for new unconstrained designs, not mandatory for every interface:
- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Choose a tone that fits the intended use: minimal, editorial, playful, refined, industrial, organic or more expressive when justified. These are options, not a requirement to choose an extreme or abandon an approved style.
- **Constraints**: Technical requirements (framework, performance, accessibility).
- **Differentiation**: What makes this UNFORGETTABLE? What's the one thing someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (HTML/CSS/JS, React, Vue, etc.) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:
- **Typography**: Respect brand, readability and accessibility requirements. For an unconstrained design, choose expressive fonts that suit its character rather than defaulting to a familiar font stack. Pair a distinctive display font with a readable body font when that serves the content.
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-only solutions for HTML. Use Motion library for React when available. Focus on high-impact moments: one well-orchestrated page load with staggered reveals (animation-delay) creates more delight than scattered micro-interactions. Use scroll-triggering and hover states that surprise.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic. Apply creative forms like gradient meshes, noise textures, geometric patterns, layered transparencies, dramatic shadows, decorative borders, custom cursors, and grain overlays.

Avoid applying generic AI-generated aesthetics without context: habitual font choices, purple gradients on white backgrounds, repetitive layouts and cookie-cutter components. A required brand font, accessible system font or familiar interaction pattern can be the correct choice; judge whether it serves this design rather than banning it by name.

Interpret creatively within the confirmed direction. Different projects may need different themes, fonts and aesthetics; related pages should retain the consistency readers need. Do not force novelty into every generation or replace an approved design simply to avoid repetition.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Remember: Claude is capable of extraordinary creative work. Don't hold back, show what can truly be created when thinking outside the box and committing fully to a distinctive vision.

## Batch Processing

> ⚠️ **For multi-component pages or applications, build incrementally: implement 1-2 components per batch**, then append to the same file via incremental edits. Do NOT create the entire page in one pass.
>
> Writing large HTML/CSS/JS files with multiple complex components in a single output WILL trigger transmission errors. This is a hard environment constraint, not a suggestion.
