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

/**
 * jsdom has no layout engine, so nothing ever *notices* an element getting a size and a real
 * `ResizeObserver` would never fire. This one delivers the element it was handed, once —
 * which is enough for a canvas library to go and measure it (through `offsetWidth` below,
 * which reads the size the element's own inline style declares). Without the delivery, nodes
 * stay unmeasured and the edges between them are never drawn at all.
 */
class ResizeObserverShim {
  private readonly notify: ResizeObserverCallback;

  constructor(notify: ResizeObserverCallback) {
    this.notify = notify;
  }

  observe(target: Element): void {
    // Deferred: the observer is created during render, and calling back into React from
    // inside its own render pass is a warning at best.
    queueMicrotask(() => {
      // Both the size *and* the rect: a node is measured through `offsetWidth`, but the
      // pan-zoom extent reads `contentRect` off the entry itself.
      const width = (target as HTMLElement).offsetWidth;
      const height = (target as HTMLElement).offsetHeight;
      const contentRect = { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height };

      this.notify(
        [{ target, contentRect } as ResizeObserverEntry],
        this as unknown as ResizeObserver
      );
    });
  }

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
