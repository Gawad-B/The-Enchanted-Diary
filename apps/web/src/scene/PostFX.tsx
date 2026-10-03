import {
  Bloom,
  DepthOfField,
  EffectComposer,
  Noise,
  ToneMapping,
  Vignette,
} from '@react-three/postprocessing';
import { useFrame } from '@react-three/fiber';
import { BlendFunction, ToneMappingMode, type DepthOfFieldEffect } from 'postprocessing';
import { useEffect, useRef, useState } from 'react';
import type { Phase } from '../state/experience';
import { damp } from './easing';
import type { PostProcessing } from './quality';

/*
 * Post-processing, by tier: `full` is selective bloom, depth of field in discovery only, vignette and
 * grain (at most 2%); `bloom` is bloom and vignette; `none` renders without a composer (the CSS vignette of the
 * stage remains). Bloom is selective in the sense that matters: its threshold sits above anything but emissive and the brightest candle-lit surfaces
 * light (the flame, the sigil's gold, the motes), so pages never bloom. Tone mapping (ACES filmic) is the
 * composer's last colour step because three does not tone map into a render target.
 */

const DOF_BOKEH = 2.4;
const DOF_FOCUS_RANGE = 2.4;

export interface PostFXProps {
  level: Exclude<PostProcessing, 'none'>;
  phase: Phase;
  /** Where the focus sits: the book. */
  focusTarget?: [number, number, number];
  multisampling: number;
  /**
   * Whether this is a calm frame (nothing turning, no camera glide): a composer is rebuilt only then. Building one
   * allocates its multisampled buffers and compiles its passes, a hitch that must not land in the middle of the cover's
   * swing (global section J: quality swaps wait for a calm frame). Calm whenever it is not given.
   */
  isCalm?: () => boolean;
}

const ALWAYS_CALM = (): boolean => true;

export function PostFX({
  level,
  phase,
  focusTarget = [0, 0.2, 0],
  multisampling,
  isCalm = ALWAYS_CALM,
}: PostFXProps) {
  // Depth of field belongs to the closed, mysterious discovery framing only (global I20). It is faded out, then removed
  // (at a calm frame: the composer is rebuilt without it), and built again, then faded in, when the discovery framing
  // comes back.
  const wantsDof = level === 'full' && phase === 'discovery';
  const [dofMounted, setDofMounted] = useState(wantsDof);
  const dof = useRef<DepthOfFieldEffect>(null);
  const strength = useRef(wantsDof ? 1 : 0);

  useFrame((_, delta) => {
    if (wantsDof && !dofMounted && isCalm()) setDofMounted(true);
    const effect = dof.current;
    if (!effect) return;
    strength.current = damp(strength.current, wantsDof ? 1 : 0, wantsDof ? 3 : 4.5, delta);
    effect.bokehScale = DOF_BOKEH * strength.current;
    // Faded out, but the composer keeps it (at nothing) until the scene is calm enough to rebuild without it.
    if (!wantsDof && strength.current < 0.02 && isCalm()) setDofMounted(false);
  });

  // The composer is rebuilt, not edited, when the set of effects changes. An edited composer that drops the depth-of-field
  // effect keeps a depth buffer its multisampled resolve no longer matches: `glBlitFramebuffer` then fails on every frame
  // ("Depth/stencil buffer format combination not allowed") and the picture freezes (the grain moves, nothing else does) once
  // the diary leaves its discovery framing, or when the monitor steps the quality down from `full` to `bloom`.
  const composerKey = `${level}-${level === 'full' && dofMounted ? 'dof' : 'plain'}`;
  // A User Timing mark at each build, so a profile can see where the hitch is.
  useEffect(() => {
    if (typeof performance !== 'undefined' && typeof performance.mark === 'function')
      performance.mark(`scene:composer-built:${composerKey}`);
  }, [composerKey]);
  return (
    <EffectComposer key={composerKey} multisampling={multisampling} enableNormalPass={false}>
      <Bloom mipmapBlur intensity={0.75} luminanceThreshold={1.35} luminanceSmoothing={0.25} radius={0.72} />
      {level === 'full' && dofMounted ? (
        <DepthOfField
          ref={dof}
          target={focusTarget}
          worldFocusRange={DOF_FOCUS_RANGE}
          bokehScale={DOF_BOKEH}
          resolutionScale={0.5}
        />
      ) : (
        <></>
      )}
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <Vignette offset={0.32} darkness={0.5} />
      {level === 'full' ? <Noise opacity={0.02} blendFunction={BlendFunction.SOFT_LIGHT} /> : <></>}
    </EffectComposer>
  );
}
