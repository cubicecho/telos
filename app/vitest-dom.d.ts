// The jest-dom matchers are registered in `vitest.setup.ts`, which lives at the
// repo root and so is outside this workspace's `include`. Importing the same
// entry point here is what makes `toBeInTheDocument` and its siblings exist for
// `tsc` as well as at runtime — the module's whole job is to augment vitest's
// `Assertion`, and an augmentation nothing imports does not apply.
import '@testing-library/jest-dom/vitest';
