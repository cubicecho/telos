/**
 * `webAs` — level 3 of the compiler's semantic control, and the only one that needs new syntax.
 *
 * Levels 1 and 2 get the tag from the element map and from ARIA the component already carries, and
 * between them they cover nearly everything. What they cannot reach is the markup that has no ARIA
 * role of its own because the DOM element *is* the semantics: `<section>`, `<nav>`, `<aside>`,
 * `<figure>`. A `<View>` wrapping a page region is a `<div>` to the element map and there is no
 * `accessibilityRole` that says otherwise.
 *
 * So `webAs` names the tag directly. `scripts/rn2web` reads it, emits that element and removes the
 * prop; on device it is declared here and used by nothing, which is the point — React Native drops
 * unknown props on the floor, so this costs one type declaration and no runtime at all.
 *
 * It is deliberately a string and not a union of tag names. The compiler is the thing that knows
 * which tags it can emit, it checks the value there, and a union here would be a second list to
 * keep in step with that one.
 */
declare module 'react-native' {
  interface ViewProps {
    /** The HTML element this becomes when compiled to the DOM. Ignored on native. */
    webAs?: string | undefined;
  }
  interface TextProps {
    /** The HTML element this becomes when compiled to the DOM. Ignored on native. */
    webAs?: string | undefined;
  }
}

export {};
