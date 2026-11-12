// Widgets render in a shadow root, so they carry their own styles. The colours and type are the community site's
// (apps/site/app/app.css in nekro-nxt-community), so a widget reads as part of the page around it.
export const STYLES = `
:host {
  --bg: #f3f1ec;
  --surface: #fffefb;
  --surface-2: #f7f7f8;
  --line: rgb(23 42 69 / 0.09);
  --line-2: rgb(23 42 69 / 0.16);
  --fg: #14243d;
  --fg-2: #44536a;
  --muted: #6b778a;
  --accent: #3f5b8f;
  --accent-soft: rgb(63 91 143 / 0.1);
  --accent-line: rgb(63 91 143 / 0.35);
  --accent-fill: #3f5b8f;
  --on-accent: #ffffff;
  --positive: #2f7d5b;
  --negative: #b4483c;
  --scrim: rgb(12 22 40 / 0.46);
  display: block;
  font-family: 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', system-ui, -apple-system,
    'Segoe UI', sans-serif;
  font-size: 14px;
  line-height: 1.6;
  color: var(--fg-2);
  container-type: inline-size;
}
@media (prefers-color-scheme: dark) {
  :host {
    --bg: #0b1524;
    --surface: #12223a;
    --surface-2: #172a46;
    --line: rgb(190 210 240 / 0.09);
    --line-2: rgb(190 210 240 / 0.15);
    --fg: #eef2f8;
    --fg-2: #c3cddc;
    --muted: #8d9ab0;
    --accent: #a3bae2;
    --accent-soft: rgb(163 186 226 / 0.12);
    --accent-line: rgb(163 186 226 / 0.4);
    --accent-fill: #4a6aa8;
    --positive: #7cc4a0;
    --negative: #e58b80;
    --scrim: rgb(2 8 18 / 0.58);
  }
}
* { box-sizing: border-box; }
button { font: inherit; color: inherit; }
.card {
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--surface);
  padding: 16px;
}
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.title { margin: 0; font-size: 14px; font-weight: 600; color: var(--fg); }
.kind { margin-right: 8px; font-size: 12px; font-weight: 500; color: var(--muted); }
.control {
  display: inline-flex; align-items: center; gap: 6px; flex: none;
  border: 1px solid var(--line-2); border-radius: 999px; background: var(--surface);
  padding: 3px 12px; font-size: 13px; cursor: pointer;
  transition: border-color 160ms, background 160ms;
}
.control:hover { border-color: var(--accent-line); background: var(--accent-soft); }
.control:focus-visible, .step:focus-visible, .pin:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* 截图导览 */
.tour { display: grid; gap: 16px; }
@container (min-width: 640px) { .tour { grid-template-columns: minmax(0, 1.75fr) minmax(200px, 1fr); align-items: start; } }
.frame { position: relative; overflow: hidden; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); }
.frame img { display: block; width: 100%; height: auto; }
.spot {
  position: absolute; border-radius: 8px; pointer-events: none;
  outline: 2px solid var(--accent-line); outline-offset: 2px;
  transition: box-shadow 260ms ease, outline-color 260ms ease;
}
.spot.on { outline: 2.5px solid var(--accent-fill); box-shadow: 0 0 0 9999px var(--scrim); }
.frame.focused .spot:not(.on) { outline-color: transparent; }
.pin {
  position: absolute; z-index: 1; width: 24px; height: 24px; margin: -12px 0 0 -12px; padding: 0;
  display: grid; place-items: center; border: 2px solid var(--surface); border-radius: 999px;
  background: var(--accent-fill); color: var(--on-accent); font-size: 12px; font-weight: 700; line-height: 1;
  box-shadow: 0 2px 6px rgb(0 0 0 / 0.25); cursor: pointer; transition: transform 200ms ease, opacity 200ms ease;
}
.frame.focused .pin:not(.on) { opacity: 0; pointer-events: none; }
.pin.on { transform: scale(1.12); }
.steps { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.step {
  display: flex; gap: 10px; width: 100%; padding: 8px 10px; text-align: left; cursor: pointer;
  border: 1px solid transparent; border-radius: 10px; background: none; line-height: 1.55;
  transition: background 160ms, border-color 160ms;
}
.step:hover { background: var(--surface-2); }
.step.on { border-color: var(--accent-line); background: var(--accent-soft); color: var(--fg); }
.num {
  flex: none; width: 22px; height: 22px; margin-top: 1px; display: grid; place-items: center; border-radius: 999px;
  background: var(--accent-soft); color: var(--accent); font-size: 12px; font-weight: 700;
}
.step.on .num { background: var(--accent-fill); color: var(--on-accent); }

/* 图解：流程 */
.canvas { position: relative; display: grid; column-gap: 72px; row-gap: 56px; padding: 22px 4px 4px; }
.canvas.vertical { row-gap: 44px; padding-top: 4px; }
.canvas.compact .node { padding: 8px 6px; }
.canvas.compact .node b { font-size: 13px; }
.canvas.compact .wire-label { padding: 0 3px; border-radius: 4px; background: var(--surface); }
.node {
  position: relative; z-index: 1; align-self: center; min-width: 0;
  border: 1.5px solid var(--line-2); border-radius: 12px; background: var(--surface);
  padding: 10px 12px; text-align: center; transition: border-color 320ms ease, background 320ms ease, opacity 320ms ease;
  opacity: 0.5;
}
.node.lit { opacity: 1; border-color: var(--accent-line); background: var(--accent-soft); }
.node.hot { border-color: var(--accent-fill); }
.node b { display: block; color: var(--fg); font-size: 14px; font-weight: 600; }
.node small { display: block; margin-top: 2px; color: var(--muted); font-size: 12px; line-height: 1.45; }
.wires { position: absolute; inset: 0; z-index: 0; overflow: visible; pointer-events: none; }
.wire { fill: none; stroke: var(--line-2); stroke-width: 1.5; transition: stroke 320ms ease; }
.wire.lit { stroke: var(--accent); }
.head-arrow { fill: var(--line-2); transition: fill 320ms ease; }
.head-arrow.lit { fill: var(--accent); }
.dot { fill: var(--accent-fill); }
.wire-label {
  position: absolute; z-index: 2; white-space: nowrap; line-height: 1.4;
  color: var(--muted); font-size: 12px; transition: opacity 320ms ease;
}

/* 图解：分层 */
.layers { display: grid; gap: 8px; }
.layer { display: grid; grid-template-columns: 112px minmax(0, 1fr); gap: 4px 14px; align-items: center;
  border: 1px solid var(--line); border-radius: 12px; background: var(--surface-2); padding: 12px 14px; }
.layer:first-child { border-color: var(--accent-line); background: var(--accent-soft); }
.layer b { color: var(--fg); font-weight: 600; }
.layer p { margin: 0; }
.chips { grid-column: 2; display: flex; flex-wrap: wrap; gap: 6px; }
.chip { padding: 0 8px; border-radius: 6px; background: var(--surface); border: 1px solid var(--line); font-size: 12px; }
@container (max-width: 480px) { .layer { grid-template-columns: minmax(0, 1fr); } .chips { grid-column: 1; } }

/* 图解：对照 */
.compare { display: grid; gap: 10px; grid-template-columns: repeat(var(--columns), minmax(0, 1fr)); }
@container (max-width: 520px) { .compare { grid-template-columns: minmax(0, 1fr); } }
.column { border: 1px solid var(--line); border-top: 3px solid var(--line-2); border-radius: 12px; padding: 12px 14px; background: var(--surface-2); }
.column.positive { border-top-color: var(--positive); }
.column.negative { border-top-color: var(--negative); }
.column b { display: block; margin-bottom: 6px; color: var(--fg); font-weight: 600; }
.column ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
.column li { display: flex; gap: 6px; line-height: 1.5; }
.column li::before { content: '·'; flex: none; width: 10px; color: var(--muted); font-weight: 700; }
.column.positive li::before { content: '✓'; color: var(--positive); }
.column.negative li::before { content: '✕'; color: var(--negative); }

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
}
`
