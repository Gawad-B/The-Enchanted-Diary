import { describe, expect, it } from 'vitest';
import { normalizeForMatch, normalizeForSearch, searchTerms } from '../src/index.js';

describe('normalizeForMatch', () => {
  it('lower-cases, strips punctuation and collapses whitespace', () => {
    expect(normalizeForMatch('  But,   I CAN   show you!!  ')).toBe('but i can show you');
    expect(normalizeForMatch('"Open the memory."')).toBe('open the memory');
  });

  it('treats "...", ".." and the ellipsis character alike', () => {
    const forms = [
      'But I can show you...',
      'But I can show you..',
      'But I can show you…',
      'But I can show you',
    ];
    expect(new Set(forms.map(normalizeForMatch)).size).toBe(1);
  });

  it('removes apostrophes inside words but separates other punctuation', () => {
    expect(normalizeForMatch("Don't stop—go")).toBe('dont stop go');
  });

  it('strips Arabic diacritics and tatweel', () => {
    expect(normalizeForMatch('دَعِ الحبر يتذكّر')).toBe('دع الحبر يتذكر');
    expect(normalizeForMatch('الـــكتاب')).toBe('الكتاب');
    expect(normalizeForMatch('قُرْآن')).toBe('قران');
  });

  it('unifies alef forms, yaa and taa marbuta', () => {
    expect(normalizeForMatch('أ إ آ ٱ')).toBe('ا ا ا ا');
    expect(normalizeForMatch('على')).toBe(normalizeForMatch('علي'));
    expect(normalizeForMatch('مدرسة')).toBe('مدرسه');
  });

  it('folds the Persian and Urdu forms of kaf, yaa and haa onto the Arabic ones, so either keyboard finds either text', () => {
    // Persian kaf (U+06A9), Persian yeh (U+06CC) and the Arabic letters typed on an Arabic keyboard.
    expect(normalizeForMatch('کتاب')).toBe(normalizeForMatch('كتاب'));
    expect(normalizeForMatch('ایران')).toBe(normalizeForMatch('ايران'));
    expect(normalizeForMatch('کتابخانه')).toBe('كتابخانه');
    // Yeh with a small v / Kurdish e (U+06D0), and the haa forms of Urdu and Kurdish (U+06C1, U+06C0, U+06D5).
    expect(normalizeForMatch('\u06D0')).toBe('\u064A');
    expect(normalizeForMatch('ہم')).toBe('هم');
    expect(normalizeForMatch('خانۀ')).toBe('خانه');
    expect(normalizeForMatch('\u06D5')).toBe('\u0647');
  });

  it('keeps the letters that only Persian and Urdu have (pe, che, zhe, gaf)', () => {
    expect(normalizeForMatch('پژوهشگران')).toBe('پژوهشگران');
    expect(normalizeForMatch('چگونه')).toBe('چگونه');
  });

  it('turns Arabic-Indic and Persian digits into ASCII digits', () => {
    expect(normalizeForMatch('١٩٩٩')).toBe('1999');
    expect(normalizeForMatch('۱۲۳۴۵۶۷۸۹۰')).toBe('1234567890');
    expect(normalizeForMatch('صفحة ٤٢')).toBe('صفحه 42');
  });

  it('folds Arabic presentation forms with NFKC', () => {
    expect(normalizeForMatch('ﻣﺮﺣﺒﺎ')).toBe('مرحبا');
    expect(normalizeForMatch('ﻻ')).toBe('لا');
  });

  it('removes invisible bidi and joiner characters', () => {
    const [rle, pdf, rlm] = [0x202b, 0x202c, 0x200f].map((code) => String.fromCharCode(code));
    expect(normalizeForMatch(`${rle}مرحبا${pdf}${rlm}`)).toBe('مرحبا');
  });

  it('removes Arabic punctuation', () => {
    expect(normalizeForMatch('ما هذا؟ نعم، حسنًا؛')).toBe('ما هذا نعم حسنا');
  });

  it('returns an empty string for empty or punctuation-only input', () => {
    expect(normalizeForMatch('')).toBe('');
    expect(normalizeForMatch(' ... — ')).toBe('');
  });
});

describe('normalizeForSearch', () => {
  it('splits number punctuation consistently', () => {
    expect(normalizeForSearch('2023-05-12')).toBe('2023 05 12');
    expect(normalizeForSearch('MS-4471')).toBe('ms 4471');
    expect(normalizeForSearch('MS 4471')).toBe(normalizeForSearch('ms-4471'));
  });

  it('matches Western and Arabic-Indic digits', () => {
    expect(normalizeForSearch('سنة ١٩٩٩')).toBe(normalizeForSearch('سنة 1999'));
  });

  it('adds Arabic light stems after the surface words', () => {
    const { surface, extra } = searchTerms('والكتاب والمدرسة بالقلم للطلاب');
    expect(surface).toEqual(['والكتاب', 'والمدرسه', 'بالقلم', 'للطلاب']);
    expect(extra).toEqual(['كتاب', 'مدرسه', 'قلم', 'طلاب']);
    expect(normalizeForSearch('والكتاب')).toBe('والكتاب كتاب');
  });

  it('does not strip a bare leading letter and keeps stems of at least three letters', () => {
    expect(searchTerms('كتاب').extra).toEqual([]);
    expect(searchTerms('بالغ').extra).toEqual([]);
    expect(searchTerms('الله').extra).toEqual([]);
    expect(searchTerms('الكتاب').extra).toEqual(['كتاب']);
  });

  it('keeps surface words in order and appends extras at the end', () => {
    expect(normalizeForSearch('الشمس والقمر')).toBe('الشمس والقمر شمس قمر');
  });

  it('adds character bigrams for Han, Kana and Hangul runs', () => {
    expect(searchTerms('北京大学').extra).toEqual(['北京', '京大', '大学']);
    expect(searchTerms('ひらがな').extra).toEqual(['ひら', 'らが', 'がな']);
    expect(searchTerms('한국어').extra).toEqual(['한국', '국어']);
    expect(searchTerms('hello').extra).toEqual([]);
  });

  it('leaves Latin text as normalised words', () => {
    expect(normalizeForSearch('The Founding, 14 March 1847.')).toBe('the founding 14 march 1847');
  });

  it('is empty for empty input', () => {
    expect(normalizeForSearch('')).toBe('');
    expect(searchTerms('  ').surface).toEqual([]);
  });
});

describe('normalizeForSearch and Persian or Urdu text', () => {
  it('gives a Persian word typed with Persian letters and with Arabic letters the same search text', () => {
    expect(normalizeForSearch('کتابخانهٔ ملی')).toBe(normalizeForSearch('كتابخانهٔ ملي'));
    expect(normalizeForSearch('ایران')).toBe(normalizeForSearch('ايران'));
  });

  it('still strips the Arabic article from a word whose letters were folded', () => {
    // الکتاب: article + Persian kaf. The light stem is كتاب, the same as for the Arabic spelling.
    expect(searchTerms('الکتاب').extra).toEqual(['كتاب']);
    expect(searchTerms('الكتاب').extra).toEqual(['كتاب']);
  });

  it('folds an Urdu sentence onto the same letters whichever heh and yeh were typed', () => {
    expect(normalizeForSearch('میں ہوں')).toBe(normalizeForSearch('ميں هوں'));
  });
});
