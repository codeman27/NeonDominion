import type { ViewBox } from './hexMapRenderer';

/**
 * Pan / pinch / wheel zoom for an SVG map by manipulating its viewBox.
 * Taps are only reported when the pointer moved < 6px, so panning never selects a territory.
 */
export class MapCamera {
  private fitBox: ViewBox = { x: 0, y: 0, w: 1, h: 1 };
  private view: ViewBox = { x: 0, y: 0, w: 1, h: 1 };
  private pointers = new Map<number, { x: number; y: number }>();
  private start = { x: 0, y: 0 };
  private moved = false;

  constructor(
    private readonly board: HTMLElement,
    private readonly svg: SVGSVGElement,
    private readonly onTap: (target: Element) => void,
    private readonly onZoom: (zoom: number) => void = () => {},
  ) {
    board.style.touchAction = 'none';
    board.addEventListener('pointerdown', e => {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.start = { x: e.clientX, y: e.clientY };
      this.moved = false;
    });
    board.addEventListener('pointermove', e => this.onMove(e));
    const end = (e: PointerEvent) => {
      const wasTap = this.pointers.size === 1 && !this.moved;
      this.pointers.delete(e.pointerId);
      if (wasTap && e.type === 'pointerup' && e.target instanceof Element) this.onTap(e.target);
    };
    board.addEventListener('pointerup', end);
    board.addEventListener('pointercancel', end);
    board.addEventListener('wheel', e => { e.preventDefault(); this.zoomAt(e.deltaY > 0 ? 1.15 : 0.87, e.clientX, e.clientY); }, { passive: false });
  }

  /** Call after every render with the renderer's fitted box. Keeps the current view unless `refit`. */
  setFitBox(box: ViewBox, refit: boolean): void {
    this.fitBox = box;
    if (refit) this.view = { ...box };
    this.apply();
  }

  fit(): void {
    this.view = { ...this.fitBox };
    this.apply();
  }

  /** 1 = whole map visible; >1 = zoomed in. */
  get zoom(): number {
    return this.fitBox.w / this.view.w;
  }

  private unitsPerPx(): number {
    return Math.max(this.view.w / this.board.clientWidth, this.view.h / this.board.clientHeight);
  }

  private onMove(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    if (Math.hypot(cur.x - this.start.x, cur.y - this.start.y) > 6) this.moved = true;
    if (this.pointers.size === 1 && this.moved) {
      const u = this.unitsPerPx();
      this.view = { ...this.view, x: this.view.x - (cur.x - prev.x) * u, y: this.view.y - (cur.y - prev.y) * u };
      this.apply();
    } else if (this.pointers.size === 2) {
      const other = [...this.pointers.entries()].find(([id]) => id !== e.pointerId)![1];
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(cur.x - other.x, cur.y - other.y);
      if (before > 0 && after > 0) this.zoomAt(before / after, (cur.x + other.x) / 2, (cur.y + other.y) / 2);
      this.moved = true;
    }
    this.pointers.set(e.pointerId, cur);
  }

  private zoomAt(factor: number, clientX: number, clientY: number): void {
    const v = this.view;
    const minW = this.fitBox.w / 5; const maxW = this.fitBox.w * 1.15;
    const w = Math.min(maxW, Math.max(minW, v.w * factor));
    const k = w / v.w;
    const r = this.board.getBoundingClientRect();
    const u = this.unitsPerPx();
    // Convert the pointer to map units, accounting for preserveAspectRatio="xMidYMid meet" letterboxing.
    const wx = v.x + (clientX - r.left) * u - (this.board.clientWidth * u - v.w) / 2;
    const wy = v.y + (clientY - r.top) * u - (this.board.clientHeight * u - v.h) / 2;
    this.view = { x: wx - (wx - v.x) * k, y: wy - (wy - v.y) * k, w: v.w * k, h: v.h * k };
    this.apply();
  }

  private apply(): void {
    const v = this.view;
    this.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    this.onZoom(this.zoom);
  }
}
