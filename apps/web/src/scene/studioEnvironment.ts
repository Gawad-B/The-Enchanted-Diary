import { PMREMGenerator, type Texture, type WebGLRenderer } from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * A tiny reflection environment made in memory (three's own RoomEnvironment, prefiltered once): nothing is
 * downloaded. Metals use it at a low intensity, so brass and gold tooling reflect something and read as metal
 * instead of orange plastic; it is not the scene's lighting (the candle is).
 */
export interface StudioEnvironment {
  texture: Texture;
  dispose(): void;
}

export function createStudioEnvironment(renderer: WebGLRenderer): StudioEnvironment | null {
  try {
    const generator = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const target = generator.fromScene(room, 0.04);
    room.dispose();
    generator.dispose();
    return {
      texture: target.texture,
      dispose: () => {
        target.dispose();
      },
    };
  } catch (error) {
    console.warn('[diary] the reflection environment could not be made; metals will look flatter', error);
    return null;
  }
}
