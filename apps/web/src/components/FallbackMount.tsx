import { FormattedText } from '../i18n/FormattedText';
import { useStrings } from '../i18n/useStrings';
import { SimpleView } from '../ui/fallback/SimpleView';

interface FallbackMountProps {
  /** Why the 3D diary is not shown, when this browser simply cannot draw it. */
  webglReason?: string | undefined;
}

/** The mount point of the 2D presenter (the simple view, ui/fallback). It keeps its test id. */
export function FallbackMount({ webglReason }: FallbackMountProps) {
  const { t, language } = useStrings();
  return (
    <div className="fallback-mount" data-testid="fallback-mount">
      <SimpleView />
      {webglReason !== undefined && (
        <p className="fallback-mount__note">
          <FormattedText
            template={t.scene.noWebgl}
            values={{
              reason: (
                <bdi className="technical-inline">
                  {language === 'ar' ? t.scene.genericReason : webglReason}
                </bdi>
              ),
            }}
          />
        </p>
      )}
    </div>
  );
}
