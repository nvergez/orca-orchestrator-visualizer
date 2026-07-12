/**
 * jsdom does not implement the layout APIs a canvas library needs — `ResizeObserver`,
 * `DOMMatrixReadOnly`, element geometry. These shims fill those gaps so React Flow can
 * mount at all.
 *
 * They are **not** a seam into React Flow, and nothing in the suite asserts on them: the
 * client tests read the DOM the node components produce (titles, chips, badges) and never
 * touch coordinates, transforms or React Flow internals — that is the implementation-detail
 * testing #12 forbids. This file exists only so that the DOM exists to read.
 */

class ResizeObserverShim {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class DOMMatrixReadOnlyShim {
  m22 = 1;
}

/** A viewport with size, so React Flow lays a canvas out instead of dividing by zero. */
const VIEWPORT = { width: 1200, height: 800 };

export function installJsdomGaps(): void {
  globalThis.ResizeObserver ??= ResizeObserverShim as unknown as typeof ResizeObserver;
  globalThis.DOMMatrixReadOnly ??= DOMMatrixReadOnlyShim as unknown as typeof DOMMatrixReadOnly;

  Object.defineProperties(globalThis.HTMLElement.prototype, {
    offsetHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return parseFloat(this.style.height) || VIEWPORT.height;
      },
    },
    offsetWidth: {
      configurable: true,
      get(this: HTMLElement) {
        return parseFloat(this.style.width) || VIEWPORT.width;
      },
    },
  });

  globalThis.SVGGraphicsElement.prototype.getBBox ??= () =>
    ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
}
