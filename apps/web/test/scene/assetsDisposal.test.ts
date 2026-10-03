import { BufferGeometry, Material, Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { createBookAssets } from '../../src/scene/book/bookAssets';
import { createSceneAssets } from '../../src/scene/sceneAssets';

/*
 * Everything the scene builds that costs GPU memory (textures, materials, geometries) must be released when the scene
 * goes away or its quality tier changes. This walks everything the assets hold and checks each one was disposed.
 */

type Resource = Texture | Material | BufferGeometry;

function canvas(width: number, height: number): HTMLCanvasElement {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

/** Every texture, material and geometry reachable through plain objects and arrays (not through three's own objects). */
function resourcesIn(root: unknown): Set<Resource> {
  const found = new Set<Resource>();
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== 'object' || seen.has(value) || depth > 6) return;
    seen.add(value);
    if (value instanceof Texture || value instanceof Material || value instanceof BufferGeometry) {
      found.add(value);
      return;
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
  };
  visit(root, 0);
  return found;
}

function watchDisposal(resources: Set<Resource>): Map<Resource, ReturnType<typeof vi.fn>> {
  const watched = new Map<Resource, ReturnType<typeof vi.fn>>();
  for (const resource of resources) {
    const spy = vi.fn();
    (resource as { addEventListener(type: 'dispose', listener: () => void): void }).addEventListener(
      'dispose',
      spy,
    );
    watched.set(resource, spy);
  }
  return watched;
}

describe('disposing the assets', () => {
  it('the book releases every texture, material and geometry it made', () => {
    const assets = createBookAssets('medium', canvas, 1, null);
    const resources = resourcesIn(assets);
    // A real book has a lot of them: the covers' textures, the leaf pool, the stacks, the spine, the binding details.
    expect(resources.size).toBeGreaterThan(40);
    const watched = watchDisposal(resources);
    assets.dispose();
    const leaked = [...watched]
      .filter(([, spy]) => spy.mock.calls.length === 0)
      .map(([resource]) => resource.type);
    expect(leaked).toEqual([]);
  });

  it('the scene releases the wood, the book and the reflection environment together', () => {
    const environment = { texture: new Texture(), dispose: vi.fn() };
    const assets = createSceneAssets('low', 1, canvas, environment);
    const watched = watchDisposal(resourcesIn({ wood: assets.wood, book: assets.book }));
    assets.dispose();
    expect([...watched].filter(([, spy]) => spy.mock.calls.length === 0)).toEqual([]);
    expect(environment.dispose).toHaveBeenCalledTimes(1);
  });

  it('a tier changes the number of resources it builds: low builds fewer leaf slots than high', () => {
    const low = createBookAssets('low', canvas, 1, null);
    const high = createBookAssets('high', canvas, 1, null);
    expect(low.slots.length).toBeLessThan(high.slots.length);
    low.dispose();
    high.dispose();
  });
});
