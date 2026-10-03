import { QUESTION_MAX_CHARS } from '@enchanted/shared';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { useStrings } from '../../i18n/useStrings';
import { useSettingsStore } from '../../state/settingsStore';
import { detectLang, firstStrongDirection } from './language';
import { caretPoint } from './quillCaret';
import { QuillMirror } from './QuillMirror';
import { useInkSpecks } from './useInkSpecks';

/** The counter appears when this much of the limit is used, and warms when this much is. */
const COUNTER_FROM = 0.85;
const COUNTER_WARM = 0.95;

export interface QuillInputHandle {
  focus(): void;
}

interface QuillInputProps {
  /** Called with the trimmed words. Return false when the diary cannot take them now: the words stay. */
  onSubmit: (text: string) => boolean;
  /** The diary is still writing: the Write button says so. The reader can go on composing. */
  busy?: boolean;
  placeholder?: string;
  handle?: Ref<QuillInputHandle>;
  onFocus?: () => void;
  /** The words the field starts with (a draft the reader left unsent). */
  initialValue?: string;
  /** Called with the words as they change (to keep a draft). */
  onValueChange?: (value: string) => void;
}

/**
 * The reader's quill: a real <textarea> (accessible name, automatic direction, the language of what is written, never
 * intercepting composition) whose glyphs are transparent, drawn again as ink by an aligned mirror layer, with a nib that follows
 * the caret and a few specks of ink flicked off fast writing. Enter writes, Shift+Enter starts a new line.
 */
export function QuillInput({
  onSubmit,
  busy = false,
  placeholder,
  handle,
  onFocus,
  initialValue = '',
  onValueChange,
}: QuillInputProps) {
  const ctx = useStrings();
  const { t } = ctx;
  const reduced = useSettingsStore((state) => state.reducedMotionResolved);
  const [value, setValue] = useState(initialValue);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const nib = useRef<HTMLSpanElement>(null);
  const composing = useRef(false);
  const direction = firstStrongDirection(value);
  const lang = detectLang(value);
  const { specks, flick, forget } = useInkSpecks(!reduced);

  useImperativeHandle(handle, () => ({
    focus: () => {
      textarea.current?.focus({ preventScroll: true });
    },
  }));

  /** Puts the nib where the caret is, from the mirror's own layout. */
  const placeNib = useCallback((): { x: number; y: number } | null => {
    const element = textarea.current;
    const nibElement = nib.current;
    if (!element || !nibElement || !field.current || !inner.current) return null;
    const box = field.current.getBoundingClientRect();
    // The field may lie on a page of the book, scaled by the screen: measure it in its own px.
    const scale = field.current.offsetWidth > 0 ? box.width / field.current.offsetWidth : 1;
    const point = caretPoint(inner.current, element.selectionStart, box, direction, scale > 0 ? scale : 1);
    if (!point) return null;
    nibElement.style.transform = `translate(${String(Math.round(point.x))}px, ${String(Math.round(point.y))}px)`;
    nibElement.style.height = `${String(Math.round(point.height))}px`;
    nibElement.dataset.placed = 'true';
    return { x: point.x, y: point.y };
  }, [direction]);

  // Grows with the words (up to a few lines, then scrolls) and keeps the mirror's scroll in step with the textarea's.
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    const maxHeight = Number.parseFloat(getComputedStyle(element).maxHeight);
    const height = Number.isFinite(maxHeight)
      ? Math.min(element.scrollHeight, maxHeight)
      : element.scrollHeight;
    if (height > 0) element.style.height = `${String(height)}px`;
    if (inner.current) inner.current.style.transform = `translateY(${String(-element.scrollTop)}px)`;
    placeNib();
  }, [value, placeNib]);

  useEffect(() => {
    const onSelection = (): void => {
      if (document.activeElement === textarea.current) placeNib();
    };
    document.addEventListener('selectionchange', onSelection);
    window.addEventListener('resize', onSelection);
    return () => {
      document.removeEventListener('selectionchange', onSelection);
      window.removeEventListener('resize', onSelection);
    };
  }, [placeNib]);

  const submit = (): void => {
    const words = value.trim();
    if (words === '') return;
    if (onSubmit(words)) {
      setValue('');
      onValueChange?.('');
      forget();
    }
    textarea.current?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // An Enter that belongs to an input method (choosing or confirming a composition) is not a submit.
    // (keyCode 229 is how Safari marks the Enter that confirms a composition; the property is deprecated, the signal is not.)
    if (
      composing.current ||
      event.nativeEvent.isComposing ||
      Reflect.get(event.nativeEvent, 'keyCode') === 229
    )
      return;
    event.preventDefault();
    submit();
  };

  const near = value.length >= QUESTION_MAX_CHARS * COUNTER_FROM;
  const counterId = 'quill-counter';
  return (
    <div className="quill" data-busy={busy} data-testid="quill">
      <div className="quill__field" ref={field}>
        <QuillMirror text={value} direction={direction} innerRef={inner} />
        <textarea
          ref={textarea}
          className="quill__textarea"
          aria-label={t.diary.inputLabel}
          aria-describedby={near ? counterId : undefined}
          dir="auto"
          {...(lang === undefined ? {} : { lang })}
          rows={1}
          maxLength={QUESTION_MAX_CHARS}
          placeholder={placeholder ?? t.invitation.writePrompt}
          spellCheck={false}
          autoComplete="off"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            onValueChange?.(event.target.value);
          }}
          onInput={(event) => {
            if (event.nativeEvent.inputType.startsWith('insert')) {
              const where = placeNib();
              if (where) flick(where.x, where.y);
              else flick(0, 0);
            }
          }}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onScroll={(event) => {
            if (inner.current)
              inner.current.style.transform = `translateY(${String(-event.currentTarget.scrollTop)}px)`;
            placeNib();
          }}
        />
        <span className="quill__nib" aria-hidden="true" ref={nib}>
          <svg viewBox="0 0 10 24" width="10" height="24" focusable="false">
            <path d="M5 0 L9 14 L5 24 L1 14 Z" />
            <circle cx="5" cy="14" r="1.2" />
          </svg>
        </span>
        <span className="quill__specks" aria-hidden="true">
          {specks.map((speck) => (
            <i
              key={speck.id}
              className="quill__speck"
              style={
                {
                  left: speck.x,
                  top: speck.y,
                  '--dx': `${String(speck.dx)}px`,
                  '--dy': `${String(speck.dy)}px`,
                } as React.CSSProperties
              }
            />
          ))}
        </span>
      </div>
      <div className="quill__foot">
        {near && (
          <span
            id={counterId}
            className="quill__counter"
            data-testid="quill-counter"
            data-warm={value.length >= QUESTION_MAX_CHARS * COUNTER_WARM}
            title={ctx.format(t.diary.counterLabel, { n: value.length, max: QUESTION_MAX_CHARS })}
          >
            {ctx.format(t.diary.counter, { n: value.length, max: QUESTION_MAX_CHARS })}
          </span>
        )}
        <button type="button" className="quill__write" aria-disabled={busy || undefined} onClick={submit}>
          {t.diary.write}
        </button>
      </div>
    </div>
  );
}
