import { describe, expect, it } from 'vitest';
import { detectLang, firstStrongDirection, scriptLanguage } from '../../src/ui/diary/language';

describe('firstStrongDirection: the direction the browser gives a dir="auto" text', () => {
  it('is the direction of the first letter that has one', () => {
    expect(firstStrongDirection('Hello مرحبا')).toBe('ltr');
    expect(firstStrongDirection('مرحبا Hello')).toBe('rtl');
    expect(firstStrongDirection('123 ... مرحبا')).toBe('rtl');
    expect(firstStrongDirection('שלום')).toBe('rtl');
  });

  it('is left to right when there is no letter at all', () => {
    expect(firstStrongDirection('')).toBe('ltr');
    expect(firstStrongDirection('12 + 3 = ?')).toBe('ltr');
  });
});

describe("detectLang: the language to label a piece of the reader's or the diary's writing with", () => {
  it('Arabic script is Arabic, Persian and Urdu letters are told apart', () => {
    expect(detectLang('من أسّس المدرسة؟')).toBe('ar');
    expect(detectLang('چه کسی آن را ساخت؟ گفت')).toBe('fa');
    expect(detectLang('یہ کتاب ٹھیک ہے')).toBe('ur');
  });

  it('Hebrew is Hebrew', () => {
    expect(detectLang('מי הקים את זה')).toBe('he');
  });

  it('text that is mostly Latin has no label of its own (it inherits the interface language)', () => {
    expect(detectLang('Who founded it?')).toBeUndefined();
    expect(detectLang('')).toBeUndefined();
  });

  it('mixed text takes the language of the majority of its letters', () => {
    expect(detectLang('ما هو اسم هذه المدرسة؟ Tips')).toBe('ar');
    expect(detectLang('What is مدرسة in the text?')).toBeUndefined();
  });
});

describe("scriptLanguage: the diary's own lines follow the question's script", () => {
  it('an Arabic question gets Arabic, a Latin one English, whatever the interface says', () => {
    expect(scriptLanguage('من أسّس المدرسة؟', 'en')).toBe('ar');
    expect(scriptLanguage('Who founded it?', 'ar')).toBe('en');
  });

  it('a question with no letters keeps the interface language', () => {
    expect(scriptLanguage('12 + 3?', 'ar')).toBe('ar');
    expect(scriptLanguage('', 'en')).toBe('en');
  });

  it('mixed text follows the script with more letters', () => {
    expect(scriptLanguage('ما هو Tips', 'en')).toBe('ar');
    expect(scriptLanguage('What is مدرسة in this text', 'ar')).toBe('en');
  });
});
