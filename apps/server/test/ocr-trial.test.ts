import { describe, expect, it } from 'vitest';
import {
  chooseLanguages,
  COMBINE_MIN_CONFIDENCE,
  FALLBACK_BELOW_CONFIDENCE,
} from '../src/ocr/language-trial.js';
import { OcrUnavailableError, type OcrResult } from '../src/ocr/types.js';

const result = (text: string, confidence: number, languages: string[]): OcrResult => ({
  text,
  confidence,
  lines: [],
  languagesUsed: languages,
});

const ENGLISH = 'The house was founded by a cartographer in the spring.';
const FRENCH =
  'La maison a été fondée par un cartographe qui a acheté la colline au printemps et qui a construit un atelier avec de hautes fenêtres.';

/** A recogniser that answers from a table keyed by the language set, and records what it was asked. */
function scripted(table: Record<string, OcrResult>): {
  recognize: (languages: string[]) => Promise<OcrResult>;
  asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    recognize: (languages) => {
      const key = languages.join('+');
      asked.push(key);
      const found = table[key];
      if (found === undefined) throw new Error(`unexpected trial ${key}`);
      return Promise.resolve(found);
    },
  };
}

describe('chooseLanguages', () => {
  it('runs a single candidate once and takes it', async () => {
    const { recognize, asked } = scripted({ eng: result(ENGLISH, 91, ['eng']) });
    const choice = await chooseLanguages({ candidates: ['eng'], extra: [], recognize });
    expect(asked).toEqual(['eng']);
    expect(choice.languages).toEqual(['eng']);
    expect(choice.decided).toBe(true);
  });

  it('runs every candidate on the page and keeps the one with the highest mean confidence', async () => {
    const { recognize, asked } = scripted({
      eng: result(ENGLISH, 95, ['eng']),
      ara: result('xx yy zz qq ww ee rr tt yy uu ii oo pp aa ss', 36, ['ara']),
    });
    const choice = await chooseLanguages({ candidates: ['eng', 'ara'], extra: [], recognize });
    expect(asked).toEqual(['eng', 'ara']);
    expect(choice.languages).toEqual(['eng']);
    expect(choice.result.confidence).toBe(95);
  });

  it('combines the two best only when both exceed the combination limit, and keeps the combination if it is not worse', async () => {
    expect(COMBINE_MIN_CONFIDENCE).toBe(60);
    const { recognize, asked } = scripted({
      eng: result(ENGLISH, 82, ['eng']),
      ara: result(ENGLISH, 71, ['ara']),
      'eng+ara': result(ENGLISH, 84, ['eng', 'ara']),
    });
    const choice = await chooseLanguages({ candidates: ['eng', 'ara'], extra: [], recognize });
    expect(asked).toEqual(['eng', 'ara', 'eng+ara']);
    expect(choice.languages).toEqual(['eng', 'ara']);
  });

  it('puts the better language first in the combination and drops a combination that is clearly worse', async () => {
    const { recognize, asked } = scripted({
      eng: result(ENGLISH, 70, ['eng']),
      ara: result(ENGLISH, 88, ['ara']),
      'ara+eng': result(ENGLISH, 60, ['ara', 'eng']),
    });
    const choice = await chooseLanguages({ candidates: ['eng', 'ara'], extra: [], recognize });
    expect(asked).toEqual(['eng', 'ara', 'ara+eng']);
    expect(choice.languages).toEqual(['ara']);
  });

  it('does not combine when the second language is below the limit', async () => {
    const { recognize, asked } = scripted({
      eng: result(ENGLISH, 95, ['eng']),
      ara: result(ENGLISH, 60, ['ara']), // exactly the limit is not "exceeding" it
    });
    const choice = await chooseLanguages({ candidates: ['eng', 'ara'], extra: [], recognize });
    expect(asked).toEqual(['eng', 'ara']);
    expect(choice.languages).toEqual(['eng']);
  });

  it('makes one extra trial when the winner reads as another allowed language, and keeps the better result', async () => {
    const { recognize, asked } = scripted({
      eng: result(FRENCH, 78, ['eng']),
      fra: result(FRENCH, 93, ['fra']),
    });
    const choice = await chooseLanguages({ candidates: ['eng'], extra: ['fra', 'spa'], recognize });
    expect(asked).toEqual(['eng', 'fra']);
    expect(choice.languages).toEqual(['fra']);
    expect(choice.result.confidence).toBe(93);
  });

  it('keeps the first result when the extra trial is no better, and never makes a second extra trial', async () => {
    const { recognize, asked } = scripted({
      eng: result(FRENCH, 90, ['eng']),
      fra: result(FRENCH, 80, ['fra']),
    });
    const choice = await chooseLanguages({ candidates: ['eng'], extra: ['fra', 'spa'], recognize });
    expect(asked).toEqual(['eng', 'fra']);
    expect(choice.languages).toEqual(['eng']);
  });

  it('is undecided when the best result holds too little text to tell languages apart', async () => {
    const { recognize } = scripted({
      eng: result('12', 60, ['eng']),
      ara: result('', 0, ['ara']),
    });
    const choice = await chooseLanguages({ candidates: ['eng', 'ara'], extra: [], recognize });
    expect(choice.decided).toBe(false);
    expect(choice.languages).toEqual(['eng']);
  });

  it('skips a candidate whose language pack is unavailable and goes on with the others', async () => {
    const recognize = (languages: string[]): Promise<OcrResult> =>
      languages[0] === 'ara'
        ? Promise.reject(new OcrUnavailableError('no ara'))
        : Promise.resolve(result(ENGLISH, 90, languages));
    const choice = await chooseLanguages({ candidates: ['ara', 'eng'], extra: [], recognize });
    expect(choice.languages).toEqual(['eng']);
  });

  it('fails when no candidate can be read at all', async () => {
    const recognize = (): Promise<OcrResult> => Promise.reject(new OcrUnavailableError('no packs'));
    await expect(
      chooseLanguages({ candidates: ['ara', 'eng'], extra: [], recognize }),
    ).rejects.toBeInstanceOf(OcrUnavailableError);
  });

  it('ignores an extra language whose pack is unavailable instead of losing the page', async () => {
    const recognize = (languages: string[]): Promise<OcrResult> =>
      languages[0] === 'fra'
        ? Promise.reject(new OcrUnavailableError('no fra'))
        : Promise.resolve(result(FRENCH, 80, languages));
    const choice = await chooseLanguages({ candidates: ['eng'], extra: ['fra'], recognize });
    expect(choice.languages).toEqual(['eng']);
  });

  it('does not swallow other failures', async () => {
    const recognize = (): Promise<OcrResult> => Promise.reject(new Error('engine crashed'));
    await expect(chooseLanguages({ candidates: ['eng'], extra: [], recognize })).rejects.toThrow(
      'engine crashed',
    );
  });

  it('also tries the other configured languages when the candidates from the document text read the page badly', async () => {
    // An English cover page and an Arabic body: the text names English, the scan is Arabic.
    expect(FALLBACK_BELOW_CONFIDENCE).toBe(50);
    const { recognize, asked } = scripted({
      eng: result('qx zv wk jh qx zv wk jh qx zv wk jh qx zv wk jh', 38, ['eng']),
      ara: result('نص عربي مقروء بوضوح تام في هذه الصفحة المصورة', 84, ['ara']),
    });
    const choice = await chooseLanguages({
      candidates: ['eng'],
      fallback: ['ara'],
      extra: [],
      recognize,
    });
    expect(asked).toEqual(['eng', 'ara']);
    expect(choice.languages).toEqual(['ara']);
  });

  it('does not try the fallback languages when a candidate reads the page well', async () => {
    const { recognize, asked } = scripted({ eng: result(ENGLISH, 91, ['eng']) });
    const choice = await chooseLanguages({ candidates: ['eng'], fallback: ['ara'], extra: [], recognize });
    expect(asked).toEqual(['eng']);
    expect(choice.languages).toEqual(['eng']);
  });

  it('keeps the candidate when the fallback languages are no better or cannot be read', async () => {
    const poor = result('qx zv wk jh qx zv wk jh qx zv wk jh qx zv wk jh', 30, ['eng']);
    const worse = scripted({ eng: poor, ara: result('', 0, ['ara']) });
    expect(
      (
        await chooseLanguages({
          candidates: ['eng'],
          fallback: ['ara'],
          extra: [],
          recognize: worse.recognize,
        })
      ).languages,
    ).toEqual(['eng']);
    const recognize = (languages: string[]): Promise<OcrResult> =>
      languages[0] === 'ara' ? Promise.reject(new OcrUnavailableError('no ara')) : Promise.resolve(poor);
    expect(
      (await chooseLanguages({ candidates: ['eng'], fallback: ['ara'], extra: [], recognize })).languages,
    ).toEqual(['eng']);
  });

  describe('Persian and Urdu (the ara pack cannot produce their letters)', () => {
    // What the real engine read from the Persian, Urdu and Arabic scan fixtures (shortened).
    const PERSIAN_BY_FAS =
      'رصدخانه قدیمی بر فراز کوهی بلند ساخته شده است و پژوهشگران گوناگون برای دیدن او می‌آمدند چراغ کوچک';
    const PERSIAN_BY_ARA =
      'رصدخانه قديى بر فراز كوه بلند ساخته شده است و بزوهشكران كوناكون براى ديدن او مى آمدند';
    const PERSIAN_BY_URD =
      'رصدخانہ قدیمی بر فراز کوہی بلند ساخته شده است و پژوهشگران گوناگون برای دیدن او می‌آمدند';
    const URDU_BY_URD =
      'پرانی رصد گاہ پہاڑ کی چوٹی پر بنی ہوئی ہے اور وہاں سے وادی اور دریا صاف دکھائی دیتے ہیں بوڑھا ماہر فلکیات ہر رات آسمان';
    const URDU_BY_FAS =
      'پرانی رصد گاه هار کی چوقی پر بنی ان وادی اور دریا صاف دکهای دیتی هیں بوره ماهر فلکیات هر رات';
    const URDU_BY_ARA =
      'بمانى رصد كاه بهار كى جولى بر بى هوئى هى اور وهان سى وادى اور دريا صاف دكهاى ديتى هين';
    const ARABIC_BY_ARA =
      'يقع المرصد القديم على قمة جبل عال يطل على الوادي وقد بناه الفلكي سليمان الحلبي ليرصد النجوم';
    const ARABIC_BY_FAS =
      'بقع الرصد القدیم علی قة جبل عال یطل علی الوادي وقد بناه الفلک سلیمان اللی لیرصد النجوم';
    const ARABIC_BY_URD =
      'یقع المرصد القدیم علی تمة جبل عال یطل علی الواديء وقد بناہ الفلکی سلیمان ا حلی لیرصد النجوم';
    const JUNK = 'qx zv wk jh qx zv wk jh qx zv wk jh qx zv wk jh';
    const EXTRA = ['fas', 'urd'];

    it('reads a Persian scan with fas: it is the pack that reads it best, and its text has the letters', async () => {
      const { recognize, asked } = scripted({
        eng: result(JUNK, 35, ['eng']),
        ara: result(PERSIAN_BY_ARA, 71, ['ara']),
        fas: result(PERSIAN_BY_FAS, 76, ['fas']),
        urd: result(PERSIAN_BY_URD, 72, ['urd']),
      });
      const choice = await chooseLanguages({ candidates: ['eng', 'ara'], extra: EXTRA, recognize });
      expect(asked).toEqual(['eng', 'ara', 'fas', 'urd']);
      expect(choice.languages).toEqual(['fas']);
      expect(choice.result.confidence).toBe(76);
    });

    it('reads an Urdu scan with urd', async () => {
      const { recognize } = scripted({
        eng: result(JUNK, 37, ['eng']),
        ara: result(URDU_BY_ARA, 62, ['ara']),
        fas: result(URDU_BY_FAS, 61, ['fas']),
        urd: result(URDU_BY_URD, 79, ['urd']),
      });
      const choice = await chooseLanguages({ candidates: ['eng', 'ara'], extra: EXTRA, recognize });
      expect(choice.languages).toEqual(['urd']);
    });

    it('keeps ara for an Arabic scan, although fas and urd read some of its letters as theirs', async () => {
      const { recognize } = scripted({
        eng: result(JUNK, 39, ['eng']),
        ara: result(ARABIC_BY_ARA, 85, ['ara']),
        fas: result(ARABIC_BY_FAS, 62, ['fas']),
        urd: result(ARABIC_BY_URD, 74, ['urd']),
      });
      const choice = await chooseLanguages({ candidates: ['eng', 'ara'], extra: EXTRA, recognize });
      expect(choice.languages).toEqual(['ara']);
    });

    it('settles a close call by the letters only Persian (or Urdu) has: they are evidence, a better score by a hair is not', async () => {
      const persian = scripted({
        eng: result(JUNK, 30, ['eng']),
        ara: result(PERSIAN_BY_ARA, 78, ['ara']),
        fas: result(PERSIAN_BY_FAS, 77, ['fas']),
        urd: result(PERSIAN_BY_URD, 60, ['urd']),
      });
      expect(
        (await chooseLanguages({ candidates: ['eng', 'ara'], extra: EXTRA, recognize: persian.recognize }))
          .languages,
      ).toEqual(['fas']);
      // The same scores on text without any of those letters: nothing says it is not Arabic.
      const arabic = scripted({
        eng: result(JUNK, 30, ['eng']),
        ara: result(ARABIC_BY_ARA, 78, ['ara']),
        fas: result(ARABIC_BY_ARA, 77, ['fas']),
        urd: result(ARABIC_BY_ARA, 60, ['urd']),
      });
      expect(
        (await chooseLanguages({ candidates: ['eng', 'ara'], extra: EXTRA, recognize: arabic.recognize }))
          .languages,
      ).toEqual(['ara']);
      // And Urdu beats Persian in a close call only with a good share of the letters only Urdu has.
      const urdu = scripted({
        eng: result(JUNK, 30, ['eng']),
        ara: result(URDU_BY_ARA, 60, ['ara']),
        fas: result(URDU_BY_FAS, 79, ['fas']),
        urd: result(URDU_BY_URD, 77, ['urd']),
      });
      expect(
        (await chooseLanguages({ candidates: ['eng', 'ara'], extra: EXTRA, recognize: urdu.recognize }))
          .languages,
      ).toEqual(['urd']);
    });

    it('does not read with packs the operator did not allow', async () => {
      const { recognize, asked } = scripted({
        eng: result(JUNK, 35, ['eng']),
        ara: result(PERSIAN_BY_ARA, 71, ['ara']),
      });
      const choice = await chooseLanguages({ candidates: ['eng', 'ara'], extra: [], recognize });
      expect(asked).toEqual(['eng', 'ara']);
      expect(choice.languages).toEqual(['ara']);
    });

    it('does not combine two packs of the same script, and goes on without a pack that is missing', async () => {
      const recognize = (languages: string[]): Promise<OcrResult> => {
        const key = languages.join('+');
        if (key === 'fas') return Promise.reject(new OcrUnavailableError('no fas'));
        if (key === 'urd') return Promise.resolve(result(PERSIAN_BY_URD, 75, ['urd']));
        if (key === 'ara') return Promise.resolve(result(PERSIAN_BY_ARA, 71, ['ara']));
        if (key === 'eng') return Promise.resolve(result(JUNK, 35, ['eng']));
        throw new Error(`unexpected read ${key}`); // a fas+urd or ara+urd combination would land here
      };
      const choice = await chooseLanguages({ candidates: ['eng', 'ara'], extra: EXTRA, recognize });
      expect(choice.languages).toEqual(['urd']);
    });
  });
});
