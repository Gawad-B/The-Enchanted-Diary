import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no canvas: without this it logs "Not implemented" for every getContext call. Reporting "no
// context" is also the truth, and it is what WebGL detection needs to see.
HTMLCanvasElement.prototype.getContext = (() => null) as HTMLCanvasElement['getContext'];

afterEach(() => {
  cleanup();
});
