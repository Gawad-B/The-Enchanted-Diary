import { useStrings } from '../../i18n/useStrings';

/**
 * The first control of the page: a link that is visible only while it has the keyboard focus and moves the focus to the
 * stage (the `main` landmark), past everything before it. It works without a fragment target, so it leaves the address alone.
 */
export function SkipLink() {
  const { t, language, direction } = useStrings();
  return (
    <a
      className="skip-link"
      href="#main"
      lang={language}
      dir={direction}
      onClick={(event) => {
        event.preventDefault();
        const main = document.querySelector<HTMLElement>('main');
        main?.focus({ preventScroll: false });
      }}
    >
      {t.a11y.skipToMain}
    </a>
  );
}
