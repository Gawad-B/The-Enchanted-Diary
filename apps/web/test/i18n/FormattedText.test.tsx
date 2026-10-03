import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FormattedText } from '../../src/i18n/FormattedText';

describe('FormattedText', () => {
  it('replaces placeholders with elements and keeps the surrounding text', () => {
    const { container } = render(
      <p>
        <FormattedText
          template="Stopped ({reason}). Showing the simple view."
          values={{ reason: <bdi>boom</bdi> }}
        />
      </p>,
    );
    expect(container).toHaveTextContent('Stopped (boom). Showing the simple view.');
    expect(container.querySelector('bdi')).toHaveTextContent('boom');
  });

  it('keeps an unknown placeholder visible and fills a repeated one each time', () => {
    const { container } = render(
      <p>
        <FormattedText template="{a} then {b} then {a}" values={{ a: 'x' }} />
      </p>,
    );
    expect(container).toHaveTextContent('x then {b} then x');
  });

  it('handles a template without placeholders', () => {
    const { container } = render(
      <p>
        <FormattedText template="Plain." values={{}} />
      </p>,
    );
    expect(container).toHaveTextContent('Plain.');
  });
});
