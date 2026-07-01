/**
 * A recording 2D context for tests. Implements the subset of
 * CanvasRenderingContext2D the renderers use and logs each operation, so draw
 * functions can be validated (call counts, coordinates) without a real browser.
 */
export interface Op {
  type: string;
  args: number[];
  fillStyle?: string;
  strokeStyle?: string;
}

export class RecordingContext {
  public ops: Op[] = [];
  public fillStyle = '#000';
  public strokeStyle = '#000';
  public lineWidth = 1;
  public lineJoin = 'miter';
  public font = '10px sans-serif';
  public textAlign = 'left';
  public textBaseline = 'alphabetic';

  public save(): void { this.ops.push({ type: 'save', args: [] }); }
  public restore(): void { this.ops.push({ type: 'restore', args: [] }); }
  public beginPath(): void { this.ops.push({ type: 'beginPath', args: [] }); }
  public closePath(): void { this.ops.push({ type: 'closePath', args: [] }); }
  public moveTo(x: number, y: number): void { this.ops.push({ type: 'moveTo', args: [x, y] }); }
  public lineTo(x: number, y: number): void { this.ops.push({ type: 'lineTo', args: [x, y] }); }
  public arc(x: number, y: number, r: number): void { this.ops.push({ type: 'arc', args: [x, y, r] }); }
  public ellipse(x: number, y: number, rx: number, ry: number): void { this.ops.push({ type: 'ellipse', args: [x, y, rx, ry] }); }
  public stroke(): void { this.ops.push({ type: 'stroke', args: [], strokeStyle: this.strokeStyle }); }
  public fill(): void { this.ops.push({ type: 'fill', args: [], fillStyle: this.fillStyle }); }
  public fillRect(x: number, y: number, w: number, h: number): void {
    this.ops.push({ type: 'fillRect', args: [x, y, w, h], fillStyle: this.fillStyle });
  }
  public strokeRect(x: number, y: number, w: number, h: number): void {
    this.ops.push({ type: 'strokeRect', args: [x, y, w, h], strokeStyle: this.strokeStyle });
  }
  public setLineDash(d: number[]): void { this.ops.push({ type: 'setLineDash', args: [...d] }); }
  public rect(x: number, y: number, w: number, h: number): void { this.ops.push({ type: 'rect', args: [x, y, w, h] }); }
  public clip(): void { this.ops.push({ type: 'clip', args: [] }); }
  public createLinearGradient(): { addColorStop(o: number, c: string): void } {
    this.ops.push({ type: 'createLinearGradient', args: [] });
    return { addColorStop: () => { this.ops.push({ type: 'addColorStop', args: [] }); } };
  }
  public fillText(_t: string, x: number, y: number): void { this.ops.push({ type: 'fillText', args: [x, y] }); }
  public measureText(t: string): { width: number } { return { width: t.length * 6 }; }
  public setTransform(): void { this.ops.push({ type: 'setTransform', args: [] }); }
  public clearRect(x: number, y: number, w: number, h: number): void { this.ops.push({ type: 'clearRect', args: [x, y, w, h] }); }
  public scale(): void { this.ops.push({ type: 'scale', args: [] }); }
  public drawImage(_img: unknown, x: number, y: number): void { this.ops.push({ type: 'drawImage', args: [x, y] }); }

  public count(type: string): number {
    return this.ops.filter((o) => o.type === type).length;
  }
}

/** Construct a recording context typed as a real one for renderer calls. */
export function makeCtx(): { ctx: CanvasRenderingContext2D; rec: RecordingContext } {
  const rec = new RecordingContext();
  return { ctx: rec as unknown as CanvasRenderingContext2D, rec };
}
