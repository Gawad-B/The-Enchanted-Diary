import { describe, expect, it } from 'vitest';
import { FRAMING_PHRASES } from '../src/rag/prompts.js';
import { arabicReplyLatinFailures, partialAnswerFailures } from './evals/checks.js';

/*
 * The live eval's checks for question 3 ("is there financial aid for international students?"), on answers the real model wrote
 * (the good ones) and on the invented-eligibility answers they must not accept (review NB-19): a pass of this row counts toward
 * ruling 9's 4 in 5, so a wrong answer must never be one.
 */

describe('the checks of question 3', () => {
  const goodEnglish = [
    'The document states that scholarships include Merit Scholarships (providing 25% to 100% tuition coverage), Need-Based Grants, and Research Fellowships for graduate students [S1]. However, the uploaded document does not state whether these financial aid options are available specifically for international students [S1].',
    'The uploaded document mentions that the university offers Merit Scholarships, Need-Based Grants, and Research Fellowships for graduate students [S1], and it also mentions Amal Housing Complex for family and international students [S2]. However, the document does not state whether financial aid specifically is available for international students [S1][S2].',
  ];
  const goodArabic = [
    'تذكر الوثيقة أنواع الدعم المالي مثل المنح الدراسية والمنح بناءً على الاحتجاج المالي والزمالات البحثية لطلاب الدراسات العليا [S1]. لكن الوثيقة لا تذكر ما إذا كان هناك دعم مالي مخصص للطلاب الدوليين.',
    'تشير الوثيقة إلى وجود منح دراسية ومنح بناءً على الاحتياجات وزمالات بحثية لطلاب الدراسات العليا [S1]، كما تذكر أن مجمع أمل السكني مخصص للعائلات والطلاب الدوليين [S2]. ولكن، لا توضح الوثيقة بصفة صريحة ما إذا كان هناك دعم مالي مخصص للطلاب الدوليين على وجه التحديد.',
  ];

  it('accepts the partial answers of the round-3 live run that an earlier version of the check wrongly failed', () => {
    // the silence is one clause of a cited sentence ("..., but it does not state whether ..."), or a "لكنها" sentence
    const english =
      'The uploaded document lists "Need-Based Grants" and "Merit Scholarships" (which offer 25% to 100% tuition coverage) [S1], but it does not state whether these forms of financial aid are available specifically for international students [S1][S2].';
    expect(partialAnswerFailures('en', english, [2, 1])).toEqual([]);
    const arabic =
      'تذكر الوثيقة أنواع المنح والدعم المالي المتاحة مثل منح التفوق، ومنح الاحتياجات المالية، والزمالات البحثية لطلاب الدراسات العليا [S1]. لكنها لا تذكر ما إذا كان هناك دعم مالي مخصص للطلاب الدوليين تحديداً [S1].';
    expect(partialAnswerFailures('ar', arabic, [2])).toEqual([]);
    const arabicOrNot =
      'تذكر الوثيقة منحاً دراسية قائمة على الجدارة ومنحاً قائمة على الاحتياجات وزمالات بحثية [S1]. لكن الوثيقة لا تذكر صراحةً هل يوجد دعم مالي مخصص للطلاب الدوليين تحديداً أم لا [S1].';
    expect(partialAnswerFailures('ar', arabicOrNot, [2])).toEqual([]);
  });

  it('accepts a real partial answer in English and in Arabic (housing for international students is not an aid claim)', () => {
    for (const text of goodEnglish) expect(partialAnswerFailures('en', text, [2]), text).toEqual([]);
    for (const text of goodArabic) expect(partialAnswerFailures('ar', text, [2, 1]), text).toEqual([]);
  });

  it('rejects an answer that invents an eligibility, whatever it says before it', () => {
    const invented = [
      'Yes, international students are eligible for Merit Scholarships, Need-Based Grants and Research Fellowships [S1].',
      'The university offers Merit Scholarships, Need-Based Grants and Research Fellowships [S1]. However, international students can apply for these scholarships.',
      'Scholarships and Need-Based Grants are open to international students [S1]. The document lists Research Fellowships [S1].',
      'Financial aid is available to international students through scholarships, grants and fellowships [S1].',
    ];
    for (const text of invented) {
      expect(partialAnswerFailures('en', text, [2]).length, text).toBeGreaterThan(0);
    }
    // a claim hidden after a comma or a semicolon, and an invented INeligibility (review NB-19)
    const hidden = [
      'The university offers Merit Scholarships, Need-Based Grants and Research Fellowships [S1], open to all students, including international students. However, the document does not state whether international students are eligible.',
      'The university offers Merit Scholarships, Need-Based Grants and Research Fellowships [S1]; international students also receive them. The document does not state who may apply.',
      'The university offers Merit Scholarships and Research Fellowships [S1]. International students are not eligible for these scholarships.',
      'The document lists Merit Scholarships and Need-Based Grants [S1] and does not state whether international students may apply, yet they cannot receive fellowships.',
      'The document lists Merit Scholarships and Need-Based Grants [S1]. Foreign students can not apply for grants.',
    ];
    for (const text of hidden) {
      expect(partialAnswerFailures('en', text, [2]).length, text).toBeGreaterThan(0);
    }
    const inventedArabic = [
      'تذكر الوثيقة منحا دراسية وزمالات بحثية [S1]. لكن الطلاب الدوليين مؤهلون للمنح.',
      'نعم، تتوفر منح دراسية ومنح الحاجة والزمالات للطلاب الدوليين [S1].',
      'المنح الدراسية ومنح الحاجة متاحة للطلاب الدوليين [S1]، والزمالات البحثية لطلاب الدراسات العليا [S1].',
      'يحق للطلاب الدوليين الحصول على دعم مالي من خلال المنح والزمالات [S1].',
    ];
    for (const text of inventedArabic) {
      expect(partialAnswerFailures('ar', text, [2]).length, text).toBeGreaterThan(0);
    }
    const hiddenArabic = [
      'تذكر الوثيقة المنح الدراسية ومنح الحاجة [S1]، بمن فيهم الطلاب الدوليون. لكن الوثيقة لا تذكر من يحق له التقدم.',
      'تذكر الوثيقة المنح الدراسية وزمالات الأبحاث [S1] ويستفيد منها الطلاب الدوليون. لكن الوثيقة لا تذكر شروط التقدم للطلاب الدوليين.',
      'تذكر الوثيقة المنح الدراسية وزمالات الأبحاث [S1]. لا يحق للطلاب الدوليين الحصول على هذه المنح.',
    ];
    for (const text of hiddenArabic) {
      expect(partialAnswerFailures('ar', text, [2]).length, text).toBeGreaterThan(0);
    }
    // "منح الحاجة" is ONE kind (the need-based grants): a reply that names only those does not name two
    const needOnly = 'تذكر الوثيقة منح الحاجة [S1]. لكن الوثيقة لا تذكر ما إذا كانت للطلاب الدوليين.';
    expect(partialAnswerFailures('ar', needOnly, [2]).join(' ')).toContain('names 1 of the 3 kinds');
  });

  it('does not take a bare "but" or "however" for the caveat, and wants the negation to be about international students', () => {
    const noCaveat =
      'The university offers Merit Scholarships, Need-Based Grants and Research Fellowships [S1]. However, graduate students may apply.';
    expect(partialAnswerFailures('en', noCaveat, [2]).join(' ')).toContain(
      'is silent about international students',
    );
    const noCaveatArabic =
      'تذكر الوثيقة منحا دراسية ومنح الحاجة وزمالات بحثية [S1]. لكن الزمالات للدراسات العليا.';
    expect(partialAnswerFailures('ar', noCaveatArabic, [2]).join(' ')).toContain(
      'is silent about international students',
    );
  });

  it('wants two kinds of aid and the page of the scholarships', () => {
    const one =
      'The document lists scholarships [S1]. It does not state whether international students may apply.';
    expect(partialAnswerFailures('en', one, [2]).join(' ')).toContain('names 1 of the 3 kinds');
    expect(partialAnswerFailures('en', goodEnglish[0] ?? '', [1, 3]).join(' ')).toContain(
      'no citation of page 2',
    );
  });

  // review fix 3, NB-19 / Checker Change: the 19 bad answers of the guards lens (13 of them passed the fix-3 checker) and the
  // good one it failed
  const CITED = 'The university offers Merit Scholarships, Need-Based Grants and Research Fellowships [S1].';
  const CITED_AR = 'تذكر الوثيقة منحاً دراسية قائمة على الجدارة ومنح الحاجة والزمالات البحثية [S1].';
  const BAD_ENGLISH = [
    `${CITED} They are not given to international students.`,
    `${CITED} They do not cover international students.`,
    `${CITED} The document does not mention any restriction so international students qualify for all of these scholarships.`,
    `${CITED} The document does not say international students are excluded from these scholarships, so they can apply.`,
    `${CITED} The document does not state whether international students are eligible, but they likely are.`,
    `${CITED} International students receive free housing and full scholarships [S2]. However, the document does not state whether any aid is earmarked for international students.`,
    `${CITED} However, the document does not state whether international students can live on campus.`,
    `${CITED} However, the document does not state whether international students can apply to graduate programs.`,
    'The university offers Merit Scholarships, Need-Based Grants and Research Fellowships [S1], and international students may apply for all of them. The document does not state any other condition about international students.',
    'The university offers Merit Scholarships, Need-Based Grants and Research Fellowships to all students including international students [S1]. The document does not state further details about international students.',
    `${CITED} International students are welcome to apply.`,
    CITED,
    `Yes, international students can receive aid: ${CITED} The document does not state any restriction for international students.`,
  ];
  const BAD_ARABIC = [
    `${CITED_AR} لكنها لا تقدم للطلاب الدوليين أي منح.`,
    `${CITED_AR} هي لا تتضمن الطلاب الدوليين.`,
    `${CITED_AR} لا تذكر الوثيقة أن الطلاب الدوليين مستبعدون من المنح، لذا يمكنهم التقدم.`,
    `${CITED_AR} يحصل الطلاب الدوليون على سكن مجاني ومنح كاملة [S2]. لكن الوثيقة لا تذكر ما إذا كان هناك دعم مالي مخصص للطلاب الدوليين.`,
    `${CITED_AR} لكن الوثيقة لا تذكر ما إذا كان الطلاب الدوليون يستطيعون السكن في الحرم.`,
    CITED_AR,
  ];

  it('fails all 19 bad answers of the fix-3 review (NB-19)', () => {
    expect(BAD_ENGLISH.length + BAD_ARABIC.length).toBe(19);
    for (const text of BAD_ENGLISH)
      expect(partialAnswerFailures('en', text, [2]).length, text).toBeGreaterThan(0);
    for (const text of BAD_ARABIC)
      expect(partialAnswerFailures('ar', text, [2]).length, text).toBeGreaterThan(0);
  });

  it('passes the good answer the fix-3 checker failed: the silence as a clause with the subject left out', () => {
    const good =
      'The document lists Merit Scholarships and Need-Based Grants [S1] and does not state whether international students may apply.';
    expect(partialAnswerFailures('en', good, [2])).toEqual([]);
    const goodArabic =
      'تذكر الوثيقة المنح الدراسية ومنح الحاجة [S1] ولا تذكر ما إذا كان هناك دعم مالي للطلاب الدوليين.';
    expect(partialAnswerFailures('ar', goodArabic, [2])).toEqual([]);
  });

  it('fails a claim made by pronoun after the silence clause of a cited sentence', () => {
    const text =
      'The document lists Merit Scholarships and Need-Based Grants [S1] and does not state whether international students may apply, but they can receive grants [S1].';
    expect(partialAnswerFailures('en', text, [2]).join(' ')).toContain('claims aid');
  });

  it('judges the caveat with the same silence rules as production: an uncited sentence must be one whole', () => {
    const text = `${CITED} The document does not state whether international students are eligible, and they should apply early.`;
    expect(partialAnswerFailures('en', text, [2]).join(' ')).toContain('uncited');
  });
});

describe('an Arabic reply has no English in it (global §T.2)', () => {
  it('fails Latin-script framing and stock phrases', () => {
    for (const text of [
      'The document states: تقع الجامعة في القاهرة [S1].',
      'تقع الجامعة في القاهرة [S1]. This suggests it is old, though the document does not say so directly.',
      'يذكر المستند أن الجامعة قديمة [S1]، though the document does not say so directly.',
      'NOT_IN_DOCUMENT',
      'لا أعرف. NOT IN DOCUMENT',
      'Ah, seeker! تقع الجامعة في القاهرة [S1].',
      'تقع الجامعة in Cairo [S1].',
      'وفقاً للوثيقة (according to the document) تقع الجامعة في القاهرة [S1].',
      'The document provides an overview of Tips Hindawi University (THU) [S1].',
    ]) {
      expect(arabicReplyLatinFailures(text).length, text).toBeGreaterThan(0);
    }
  });

  it('fails the English framing of the answer prompt, and passes its Arabic framing', () => {
    expect(
      arabicReplyLatinFailures(`تقع الجامعة في القاهرة [S1]. ${FRAMING_PHRASES.en.direct}`).length,
    ).toBeGreaterThan(0);
    expect(
      arabicReplyLatinFailures(FRAMING_PHRASES.en.inference.replace('...', 'it is old')).length,
    ).toBeGreaterThan(0);
    expect(arabicReplyLatinFailures(FRAMING_PHRASES.ar.example)).toEqual([]);
    expect(arabicReplyLatinFailures(FRAMING_PHRASES.ar.inference.replace('...', 'أن الجامعة قديمة'))).toEqual(
      [],
    );
  });

  it('allows the excerpt markers, proper names and acronyms, and document text quoted verbatim', () => {
    for (const text of [
      'يذكر المستند أن رئيس الجامعة هو الدكتور نبيل الخطيب (Dr. Nabil Al-Khatib) [S1].',
      'تقع جامعة تيبس هنداوي (Tips Hindawi University - THU) في القاهرة [S2][S3].',
      'يذكر المستند أن المنح متاحة للطلاب [S1]، وإن لم يذكره المستند صراحة.',
      'لم أتمكن من العثور على هذه المعلومة في المستند. يبدو أن ملف PDF المقدَّم لا يغطي هذا الموضوع.',
      'تشمل الكليات كلية الهندسة (Faculty of Engineering) [S1].',
      'الرسوم للمرحلة الجامعية (Undergraduate) بين 5000 و8000 دولار [S1].',
    ]) {
      expect(arabicReplyLatinFailures(text), text).toEqual([]);
    }
    const quote = 'يشترط القبول اختبار الكفاءة في اللغة الإنجليزية (IELTS 6.0 or TOEFL 80) [S1].';
    expect(arabicReplyLatinFailures(quote).length).toBeGreaterThan(0);
    expect(arabicReplyLatinFailures(quote, ['• English proficiency test (IELTS 6.0 or TOEFL 80)'])).toEqual(
      [],
    );
  });
});
