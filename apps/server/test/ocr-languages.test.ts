import { describe, expect, it } from 'vitest';
import { candidateLanguages, iso1For, tesseractCodeFor } from '../src/ocr/languages.js';

const ENGLISH =
  'The house was founded by a cartographer who bought the hill in the spring and built a workroom with tall north windows for his maps and charts.';
const ARABIC =
  'تقع المكتبة في قلب المدينة القديمة وقد بنيت قبل أكثر من ثلاثة قرون لتحفظ المخطوطات النادرة ويزورها الباحثون من مختلف البلدان';
const FRENCH =
  'La maison a été fondée par un cartographe qui a acheté la colline au printemps et qui a construit un atelier avec de hautes fenêtres au nord pour ses cartes.';
const PERSIAN =
  'کتابخانه در قلب شهر قدیمی قرار دارد و بیش از سه قرن پیش برای نگهداری دست‌نوشته‌های کمیاب ساخته شده است و پژوهشگران از کشورهای گوناگون می‌آیند';

describe('language codes', () => {
  it('maps ISO 639-1 codes to Tesseract packs and back', () => {
    expect(tesseractCodeFor('en')).toBe('eng');
    expect(tesseractCodeFor('ar')).toBe('ara');
    expect(tesseractCodeFor('fa')).toBe('fas');
    expect(tesseractCodeFor('ur')).toBe('urd');
    expect(tesseractCodeFor('xx')).toBeUndefined();
    expect(iso1For('eng')).toBe('en');
    expect(iso1For('ara')).toBe('ar');
    expect(iso1For('zzz')).toBeUndefined();
  });
});

describe('candidateLanguages (the languages tried on the first OCR page)', () => {
  const configured = ['eng', 'ara'];
  const allowed = ['eng', 'ara', 'fra', 'spa', 'deu', 'ita', 'por', 'tur', 'fas', 'urd'];

  it('uses OCR_LANGUAGES when no page has usable text', () => {
    expect(candidateLanguages('', { configured, allowed })).toEqual(['eng', 'ara']);
    expect(candidateLanguages('Page 12', { configured, allowed })).toEqual(['eng', 'ara']);
  });

  it('uses the language of the text pages when it is known and allowed', () => {
    expect(candidateLanguages(ENGLISH, { configured, allowed })).toEqual(['eng']);
    expect(candidateLanguages(ARABIC, { configured, allowed })).toEqual(['ara']);
    expect(candidateLanguages(FRENCH, { configured, allowed })).toEqual(['fra']);
    expect(candidateLanguages(PERSIAN, { configured, allowed })).toEqual(['fas']);
  });

  it('lists every language of a bilingual sample, largest share first, at most three', () => {
    expect(candidateLanguages(`${ARABIC} ${ARABIC} ${ENGLISH}`, { configured, allowed })).toEqual([
      'ara',
      'eng',
    ]);
    const many = `${ENGLISH} ${ENGLISH} ${FRENCH} ${FRENCH} ${ARABIC} ${PERSIAN}`;
    expect(candidateLanguages(many, { configured, allowed }).length).toBeLessThanOrEqual(3);
  });

  it('never uses a pack the operator did not allow', () => {
    expect(candidateLanguages(FRENCH, { configured, allowed: ['eng', 'ara'] })).toEqual(['eng', 'ara']);
  });
});
