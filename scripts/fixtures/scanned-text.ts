/*
 * The text of the scanned fixtures. Everything here is original. The tests that read the scans carry their own copy of
 * what they expect, on purpose: a test that imports its expectation from the generator proves nothing about either.
 */

export const SCANNED_EN_PAGES: { heading: string; paragraphs: string[] }[] = [
  {
    heading: 'The Lighthouse at Saltmarsh',
    paragraphs: [
      'The lighthouse at Saltmarsh was built in 1884 by a mason named Oswin Hartley, who carried every stone from the quarry on a flat wooden cart. For forty winters the lamp was tended by the keeper Marguerite Dunmore, who recorded the weather in a blue ledger.',
      'Ships passing the headland could see the beam for twelve miles, and the harbour master praised its steady light.',
    ],
  },
  {
    heading: 'The Blue Ledger',
    paragraphs: [
      'The blue ledger survives in the village archive. Its last entry, dated 3 November 1923, reads that the fog bell rang for nine hours and that three fishing boats found the harbour safely.',
      "After the keeper retired the lamp was automated, and the keeper's cottage became a small museum open on summer weekends.",
    ],
  },
];

/** Three short pages (A5): one distinctive place name each. */
export const SCANNED_THREE_PAGES: string[] = [
  'Chapter one describes the arrival of the surveyors at the harbour of Wexcombe, where the first measurements were taken on a grey morning.',
  'Chapter two follows the road inland to the village of Pennyfold, where an old mill still grinds barley for the local bakery.',
  'Chapter three ends at the summit of Kettle Hill, from which the whole valley and the winding river can be seen on a clear day.',
];

export const MIXED_SCANNED = {
  /** Page 1 has a text layer. */
  text: 'Field notes from the marsh survey. The survey began in March and covered nine stations along the northern bank. Water levels were recorded at dawn each day.',
  /** Page 2 is an image of this. */
  scan: 'The second station lies beside the old pumping house. Herons nest in the reeds there, and the surveyors counted forty two nests in the spring of that year.',
};

/** One page scanned at 600 DPI: an image of more than 16 million pixels. */
export const SCANNED_LARGE_TEXT =
  'A high resolution scan keeps every detail of the page, but its image is far larger than the limit used when the text of a page is read. The scan of the harbour register was made at six hundred dots per inch.';

export const SCANNED_AR = {
  heading: 'المرصد القديم',
  paragraphs: [
    'يقع المرصد القديم على قمة جبل عال يطل على الوادي، وقد بناه الفلكي سليمان الحلبي ليرصد النجوم والكواكب في الليالي الصافية.',
    'ما زالت المراصد الصغيرة تعمل في القرية، ويزورها الأطفال في الصيف ليتعلموا أسماء النجوم.',
  ],
};

/** Persian: the letters Arabic does not have (پ چ ژ گ) and Persian kaf and yeh. */
export const SCANNED_FA = {
  heading: 'رصدخانه قدیمی',
  paragraphs: [
    'رصدخانه قدیمی بر فراز کوهی بلند ساخته شده است و از آنجا دره و رودخانه پیدا است. ستاره‌شناس پیر هر شب آسمان را با دقت می‌نگریست و پژوهشگران گوناگون برای دیدن او می‌آمدند.',
    'چراغ کوچک رصدخانه تا بامداد روشن می‌ماند و کودکان در تابستان نام ستارگان را یاد می‌گیرند.',
  ],
};

/** Urdu: the letters only Urdu has (ٹ ڈ ڑ ں ے) and the two heh forms. */
export const SCANNED_UR = {
  heading: 'پرانی رصد گاہ',
  paragraphs: [
    'پرانی رصد گاہ پہاڑ کی چوٹی پر بنی ہوئی ہے اور وہاں سے وادی اور دریا صاف دکھائی دیتے ہیں۔ بوڑھا ماہرِ فلکیات ہر رات آسمان کو غور سے دیکھتا تھا اور دور دور سے لوگ اسے ملنے آتے تھے۔',
    'گاؤں کے بچے گرمیوں میں ستاروں کے نام سیکھنے آتے ہیں اور چھوٹا چراغ صبح تک جلتا رہتا ہے۔',
  ],
};

/** French: the language trial must find its way to the `fra` pack from English and Arabic candidates. */
export const SCANNED_FR_PAGE: string[] = [
  'Le phare de Saltmarsh fut construit en 1884 par un maçon nommé Oswin Hartley, qui transporta chaque pierre depuis la carrière sur une charrette en bois. Pendant quarante hivers, la lampe fut entretenue par la gardienne Marguerite Dunmore, qui notait le temps qu’il faisait dans un registre bleu.',
  'Les navires qui passaient devant le cap voyaient le faisceau à plus de vingt kilomètres, et le maître du port louait sa lumière régulière.',
];
