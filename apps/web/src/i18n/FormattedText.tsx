import { Fragment, type ReactNode } from 'react';

interface FormattedTextProps {
  /** A line from the dictionary with `{name}` placeholders. */
  template: string;
  /** What replaces each placeholder. A placeholder without a value stays in the text. */
  values: Record<string, ReactNode>;
}

/**
 * Like `format()`, but the values may be elements. It exists for technical fragments (an error reason, a
 * file name) that sit inside a translated sentence: wrapped in <bdi> they keep their own direction and do not
 * scramble the order of an Arabic sentence around them.
 */
export function FormattedText({ template, values }: FormattedTextProps) {
  const parts = template.split(/(\{\w+\})/);
  return (
    <>
      {parts.map((part, index) => {
        const name = /^\{(\w+)\}$/.exec(part)?.[1];
        const value = name === undefined ? undefined : values[name];
        return <Fragment key={`${String(index)}-${part}`}>{value ?? part}</Fragment>;
      })}
    </>
  );
}
