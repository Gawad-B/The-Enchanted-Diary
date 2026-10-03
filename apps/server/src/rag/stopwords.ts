import { normalizeForMatch } from '@enchanted/shared';

/*
 * Small built-in stopword lists, used only on the QUERY side of lexical search: words that occur in nearly every
 * text say nothing about which chunk answers a question. Words are put through the SAME normaliser
 * as the query tokens (`normalizeForMatch`: lower case, apostrophes dropped, Arabic alef / taa marbuta / alef maqsura
 * unified; Latin accents are KEPT, at index time and query time alike), so they must be written as people write them:
 * "très", "für", "está", "nasıl" are listed with their accents (and the unaccented forms too, for questions typed without
 * them), and elisions ("qu'est-ce", "c'est", "d'un") as the normaliser leaves them ("quest", "cest", "dun"). The lists are deliberately short: the document's
 * own frequencies (idf, in retrieve.ts) handle everything else, including words that are common in THIS document.
 */

const words = (list: string): string[] => list.split(/\s+/u).filter((word) => word !== '');

const ENGLISH = words(`
  a an the and or but if then else of to in on at by for with from into onto about as is are was were be been being
  am do does did done have has had having it its this that these those there here he she they them his her their we
  our you your i me my who whom whose what which when where why how can could would should shall will may might must
  not no nor so than too very just also only any some such each every both either neither more most other another
  tell me please explain describe say says said whats whos hows
`);

const ARABIC = words(`
  من في على الى عن مع بين عند حتى ثم لكن الا او ان انه انها انهم اذا اذ لو لا لم لن ما ماذا هل هو هي هم هن هذا هذه
  هذان هاتان ذلك تلك اولئك هنا هناك هنالك كان كانت كانوا يكون تكون كل بعض غير قد لقد كيف متى اين لماذا اي ايا
  كم الذي التي الذين اللذان اللتان بعد قبل فوق تحت حول خلال منذ نحو عبر له لها لهم لنا لك به بها بهم فيه فيها
  عليه عليها منه منها عنه عنها ايضا فقط جدا تم يتم ليس ليست ولا وما وهل وان وقد ثم
`);

const FRENCH = words(`
  très trés où était étaient été à déjà là dès après même quelqu'un quest cest nest dun dune lon jai mest sest lest qu quoi-que souvent toujours jamais encore déjà alors ainsi parce mais donc car dont aucun chaque plusieurs tout tous toute toutes y
  le la les un une des du de et ou mais si donc ni en dans sur sous par pour avec sans chez vers est sont
  etait etaient etre ete a ont avait avoir ce cet cette ces il ils elles on nous vous je tu me te se lui leur
  leurs qui que quoi dont ou quand comment pourquoi quel quelle quels quelles ne pas plus tres aussi seulement
  larchive dun dune
`);

const SPANISH = words(`
  está están estás qué quién quiénes cuál cuáles cuándo dónde cómo también más sólo sí sé tú él éste ésta aquí allí ahí así aún todavía siempre nunca muy mucho poco otro otra otros otras cada todo todos toda todas
  el la los las un una unos unas y o pero si entonces de del al en sobre bajo por para con entre hacia es
  eran ser fue han ha habia haber este esta estos estas ese esa esos esas eso esto el ella ellos ellas nosotros
  usted ustedes yo tu me te se lo le les su sus mi mis que quien quienes cual cuales cuando donde como por
  porque no mas muy tambien solo
`);

const GERMAN = words(`
  für über während wäre wären würde würden müssen können gewesen worden hätte hätten dafür darüber dabei damit davon dazu immer nie oft schon noch dann denn weil dass daß ob jede jeder jedes alle alles manche mehr
  der die das den dem des ein eine einen einem einer eines und oder aber wenn dann von zu in im an am auf aus bei
  mit nach vor uber unter fur durch gegen ohne um ist sind waren sein bist wird werden wurde wurden hat
  haben hatte hatten es er sie wir ihr ich du man dieser diese dieses jener welche welcher welches wer was wo wann
  warum wie nicht kein keine auch nur sehr noch schon
`);

const ITALIAN = words(`
  è più perché così già là però cioè dov'è dove quindi sempre mai molto poco ogni tutto tutti tutta tutte altro altri altra altre sul sulla nel nella dall dalla dell dello un'
  il lo la i gli le un uno una di del dello della dei degli delle a al allo alla ai agli alle da dal dallo dalla in
  nel nello nella con su sul sulla per tra fra e o ma se allora che chi cui come dove quando perche non piu molto
  anche solo e sono erano essere stato ha hanno aveva avere questo questa questi queste quello quella lui lei
  loro noi voi io tu mi ti si
`);

const PORTUGUESE = words(`
  não são está estão é há também só já até então porém porque sempre nunca muito pouco outro outra outros outras cada todo todos toda todas aqui ali lá onde
  o a os as um uma uns umas de do da dos das em no na nos nas por para com sem entre sobre sob e ou mas se entao
  que quem qual quais quando onde como porque nao mais muito tambem so e sao eram ser foi ha tinha ter este
  esta estes estas esse essa esses essas isso isto ele ela eles elas nos voces eu tu me te se lhe seu sua seus suas
`);

const TURKISH = words(`
  nasıl çok değil için neden nerede hangi kaç şu bunu onu şunu bunlar şey hiçbir hep hala yine daha artık sadece ancak fakat ya hem ne kim niçin mı mi mu mü diye gibi kadar sonra önce
  ve veya ama ise de da ki bir bu su o bunlar sunlar onlar ben sen biz siz ne nasil neden nerede kim hangi kac icin
  ile gibi kadar daha cok en mi mu hem hic her olan olarak var yok degil
`);

const PERSIAN = words(`
  و در به از که این آن را با برای است بود هست هستند بودند شد شده می هم یا تا چه کی کجا چرا چگونه کدام چند
  نیز اما اگر پس بر روی زیر میان درباره خود او ما شما آنها چیست کسی مورد
`);

const URDU = words(`
  کا کی کے میں ہے ہیں اور سے کو پر یہ وہ کہ بھی نے تھا تھی تھے کیا کون کب کہاں کیوں کیسے ایک تو ہی لیے ساتھ کس بارے
`);

/**
 * Every word that is a stopword in any of the supported languages, put through the shared normaliser so that the list
 * is always in the form the query tokens have (Persian and Urdu letter variants folded onto the Arabic letters, ...).
 */
export const STOPWORDS: ReadonlySet<string> = new Set(
  [
    ...ENGLISH,
    ...ARABIC,
    ...FRENCH,
    ...SPANISH,
    ...GERMAN,
    ...ITALIAN,
    ...PORTUGUESE,
    ...TURKISH,
    ...PERSIAN,
    ...URDU,
  ]
    .map((word) => normalizeForMatch(word))
    .filter((word) => word !== ''),
);
