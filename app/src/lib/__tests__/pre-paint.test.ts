import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_PRE_PAINT_SCRIPT } from '@/components/ui/theme-preference-base';

// `public/index.html` carries a pasted copy of cubeui's pre-paint script, since
// it runs before any of the bundle exists. Re-adding the `theme-picker` item
// can change the original; this is what notices.
describe('the pre-paint script in index.html', () => {
  it('is cubeui’s, verbatim', () => {
    const html = readFileSync(path.resolve(__dirname, '../../../public/index.html'), 'utf8');
    expect(html).toContain(THEME_PRE_PAINT_SCRIPT);
  });
});
