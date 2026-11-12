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
.head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; margin-bottom: 12px; }
.title { flex: 1 1 14em; margin: 0; font-size: 14px; font-weight: 600; color: var(--fg); }
.kind { margin-right: 8px; font-size: 12px; font-weight: 500; color: var(--muted); }
.control {
  display: inline-flex; align-items: center; gap: 6px; flex: none;
  border: 1px solid var(--line-2); border-radius: 999px; background: var(--surface);
  padding: 3px 12px; font-size: 13px; cursor: pointer;
  transition: border-color 160ms, background 160ms;
}
.control:hover:not(:disabled) { border-color: var(--accent-line); background: var(--accent-soft); }
.control:disabled { opacity: 0.4; cursor: default; }
.control.icon { width: 30px; padding: 3px 0; justify-content: center; font-size: 16px; line-height: 1.3; }
.controls { display: inline-flex; gap: 6px; flex: none; }
:is(.control, .step, .pin, .stage, .choice, .taken, .segmented button):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.muted { color: var(--muted); }

/* 截图导览 */
.tour { display: grid; gap: 14px; }
.frame { position: relative; overflow: hidden; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); }
.zoom { position: relative; transform-origin: 0 0; transition: transform 420ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.frame img { display: block; width: 100%; height: auto; }
.spot {
  position: absolute; border-radius: calc(8px / var(--zoom, 1)); pointer-events: none;
  outline: calc(2px / var(--zoom, 1)) solid var(--accent-line); outline-offset: calc(2px / var(--zoom, 1));
  transition: box-shadow 260ms ease, outline-color 260ms ease;
}
.spot.on { outline: calc(2.5px / var(--zoom, 1)) solid var(--accent-fill); box-shadow: 0 0 0 9999px var(--scrim); }
.frame.focused .spot:not(.on) { outline-color: transparent; }
.pin {
  position: absolute; z-index: 1; width: 24px; height: 24px; margin: -12px 0 0 -12px; padding: 0;
  transition: left 420ms cubic-bezier(0.2, 0.8, 0.2, 1), top 420ms cubic-bezier(0.2, 0.8, 0.2, 1), transform 200ms ease, opacity 200ms ease;
  display: grid; place-items: center; border: 2px solid var(--surface); border-radius: 999px;
  background: var(--accent-fill); color: var(--on-accent); font-size: 12px; font-weight: 700; line-height: 1;
  box-shadow: 0 2px 6px rgb(0 0 0 / 0.25); cursor: pointer;
}
.frame.focused .pin:not(.on) { opacity: 0; pointer-events: none; }
.pin.on { transform: scale(1.12); }
.steps { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr)); }
dialog.full {
  max-width: 96vw; max-height: 94vh; padding: 44px 12px 12px; overflow: auto;
  border: 1px solid var(--line-2); border-radius: 12px; background: var(--surface); color: var(--fg-2);
}
dialog.full::backdrop { background: var(--scrim); }
dialog.full img { display: block; max-width: none; height: auto; border-radius: 6px; }
.close { position: absolute; top: 8px; right: 12px; }
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

/* 链路动画 */
.track { margin: 0; padding: 4px 0 0; list-style: none; display: grid; grid-template-columns: repeat(calc(var(--stages) - 1), minmax(0, 1fr)) auto; }
.stop { display: flex; align-items: flex-start; min-width: 0; }
.stage {
  position: relative; z-index: 1; flex: none; width: 104px; display: grid; justify-items: center; gap: 2px; padding: 4px 2px; cursor: pointer;
  border: none; border-radius: 10px; background: none; text-align: center;
}
.stage .num {
  width: 34px; height: 34px; margin: 0 0 4px; font-size: 14px;
  border: 1.5px solid var(--line-2); background: var(--surface); color: var(--muted);
  transition: background 300ms ease, border-color 300ms ease, color 300ms ease, box-shadow 300ms ease;
}
.stage b { color: var(--fg-2); font-size: 13px; font-weight: 600; line-height: 1.4; }
.stage small { color: var(--muted); font-size: 12px; line-height: 1.4; }
.stop.passed .num { border-color: var(--accent-line); background: var(--accent-soft); color: var(--accent); }
.stop.here .num { border-color: var(--accent-fill); background: var(--accent-fill); color: var(--on-accent); box-shadow: 0 0 0 5px var(--accent-soft); }
.stop.here b, .stop.passed b { color: var(--fg); }
.stop.ahead .stage { opacity: 0.62; }
.stage:hover .num { border-color: var(--accent-line); }
.link { position: relative; flex: 1; min-width: 12px; height: 2px; margin: 20px -35px 0; background: var(--line-2); border-radius: 2px; }
.link-fill { position: absolute; inset: 0; transform-origin: left; transform: scaleX(var(--fill)); background: var(--accent); border-radius: 2px; }
.packet {
  position: absolute; top: 50%; left: calc(var(--at) * 100%); width: 12px; height: 12px; margin: -6px 0 0 -6px;
  border-radius: 999px; background: var(--accent-fill); box-shadow: 0 0 0 4px var(--accent-soft);
}
.detail { margin-top: 14px; min-height: 5.4em; border-radius: 10px; background: var(--surface-2); padding: 10px 14px; }
.detail p { margin: 0; }
.detail b { margin-right: 8px; color: var(--fg); font-weight: 600; }
@container (max-width: 560px) {
  .track { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .stop { flex-direction: column; }
  .stage { width: 100%; grid-template-columns: auto minmax(0, 1fr); justify-items: start; align-items: center; column-gap: 10px; text-align: left; }
  .stage .num { grid-row: span 2; margin: 0; }
  .stage small { grid-column: 2; }
  .link { flex: none; width: 2px; height: 14px; min-width: 0; margin: -4px 0 -4px 20px; }
  .link-fill { transform-origin: top; transform: scaleY(var(--fill)); }
  .packet { top: calc(var(--at) * 100%); left: 50%; }
}

/* 聊天回放 */
.modes { display: grid; justify-items: center; gap: 6px; margin-bottom: 12px; }
.segmented { display: inline-flex; flex-wrap: wrap; justify-content: center; gap: 2px; padding: 3px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--line); }
.segmented button { border: none; border-radius: 999px; background: none; padding: 3px 14px; font-size: 13px; cursor: pointer; transition: background 160ms, color 160ms; }
.segmented button.on { background: var(--accent-fill); color: var(--on-accent); }
.mode-note { margin: 0; color: var(--muted); font-size: 12px; text-align: center; }
.chat {
  max-width: 400px; margin: 0 auto; padding: 14px 12px; list-style: none; display: grid; gap: 10px;
  border-radius: 16px; background: var(--surface-2); border: 1px solid var(--line);
}
.turn { display: grid; gap: 10px; }
.message { display: flex; gap: 8px; align-items: flex-start; visibility: hidden; opacity: 0; }
.message.in { visibility: visible; opacity: 1; animation: rise 260ms ease; }
.message.typing { visibility: visible; opacity: 1; }
.message.typing .bubble { visibility: hidden; }
.avatar {
  flex: none; width: 30px; height: 30px; display: grid; place-items: center; border-radius: 999px;
  background: var(--line-2); color: var(--fg); font-size: 13px; font-weight: 600;
}
.message.agent .avatar { background: var(--accent-fill); color: var(--on-accent); }
.said { position: relative; min-width: 0; display: grid; justify-items: start; gap: 2px; }
.who { color: var(--muted); font-size: 12px; line-height: 1.3; }
.message.agent .who { color: var(--accent); }
.bubble { margin: 0; padding: 7px 11px; border-radius: 4px 12px 12px 12px; background: var(--surface); border: 1px solid var(--line); color: var(--fg); line-height: 1.5; overflow-wrap: anywhere; }
.message.agent .bubble { background: var(--accent-soft); border-color: var(--accent-line); }
.quiet { color: var(--muted); font-size: 12px; }
.quiet::before { content: '— '; }
.typing-dots { display: none; position: absolute; left: 0; top: 18px; gap: 4px; padding: 11px 12px; border-radius: 4px 12px 12px 12px; background: var(--accent-soft); border: 1px solid var(--accent-line); }
.message.typing .typing-dots { display: inline-flex; }
.typing-dots i { width: 6px; height: 6px; border-radius: 999px; background: var(--accent); opacity: 0.4; animation: blink 1s infinite; }
.typing-dots i:nth-child(2) { animation-delay: 160ms; }
.typing-dots i:nth-child(3) { animation-delay: 320ms; }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } }
@keyframes blink { 50% { opacity: 1; } }

/* 排查向导 */
.trail { margin: 0 0 10px; padding: 0; list-style: none; display: grid; gap: 4px; }
.taken {
  width: 100%; display: flex; justify-content: space-between; gap: 12px; padding: 6px 10px; cursor: pointer; text-align: left;
  border: none; border-radius: 8px; background: var(--surface-2); color: var(--muted); font-size: 13px; line-height: 1.5;
}
.taken:hover { color: var(--fg-2); }
.taken b { flex: none; color: var(--accent); font-weight: 600; }
.ask { animation: rise 220ms ease; }
.question { margin: 0 0 10px; color: var(--fg); font-weight: 600; }
.choices { display: flex; flex-wrap: wrap; gap: 8px; }
.choice {
  padding: 6px 16px; cursor: pointer; border: 1px solid var(--accent-line); border-radius: 999px;
  background: var(--surface); color: var(--accent); transition: background 160ms;
}
.choice:hover { background: var(--accent-soft); }
.answer { border: 1px solid var(--line); border-left: 3px solid var(--positive); border-radius: 10px; background: var(--surface-2); padding: 10px 14px; }
.answer p { margin: 0; color: var(--fg); }
.answer a { display: inline-block; margin-top: 6px; color: var(--accent); font-size: 13px; text-decoration: none; }
.answer a:hover { text-decoration: underline; }

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`
