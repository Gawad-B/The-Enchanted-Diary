import { ar } from './ar';
import { en } from './en';
import type { Language, Strings } from './types';

export { format } from './format';
export type { Language, Strings } from './types';

/**
 * Every language has to provide every key: `Strings` is the single type both dictionaries are checked
 * against, so a copy line added to `types.ts` fails the build until `en.ts` and `ar.ts` both have it.
 */
export const STRINGS: Record<Language, Strings> = { en, ar };
