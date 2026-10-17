import type { StepScaleMaterial } from './step-scale.js'

/**
 * The living fill of a {@link StepScaleMaterial}: domain-warped noise drifting through the fill colour, with no dots,
 * lines or flashes. `flow` drifts towards the knob in long horizontal currents and leans to lumen blue there; `heat`
 * rises in tall faint wisps. Loaded on demand; draws nothing without WebGL, under reduced motion, while the page is
 * hidden or while the scale is off screen, and the plain CSS gradient shows instead.
 */
const FRAGMENT = `precision mediump float;
uniform vec2 size; uniform float time; uniform vec3 from; uniform vec3 to; uniform vec3 lumen; uniform vec3 light;
uniform float strength; uniform vec2 drift; uniform vec2 grain; uniform float lean;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int k = 0; k < 4; k++) { v += a * noise(p); p = p * 2.03 + 7.1; a *= 0.5; }
  return v;
}
void main() {
  vec2 px = gl_FragCoord.xy;
  float u = px.x / size.x;
  vec3 base = mix(from, to, u);
  base = mix(base, lumen, smoothstep(0.45, 1.0, u) * lean * strength);
  vec2 q = vec2(px.x / grain.x - time * drift.x, px.y / grain.y - time * drift.y);
  vec2 w = vec2(fbm(q + vec2(0.0, time * 0.15)), fbm(q + vec2(5.2, 1.3)));
  float f = fbm(q + 1.7 * w);
  vec3 color = base * (0.94 + 0.12 * f * strength) + light * smoothstep(0.52, 0.85, f) * 0.16 * strength;
  color += vec3(0.05) * smoothstep(0.55, 1.0, px.y / size.y) * strength;
  gl_FragColor = vec4(color, 1.0);
}`

const LOOKS = {
  flow: { drift: [0.9, -0.05], grain: [80, 20], lean: 0.38, light: 'color-mix(in srgb, var(--focus) 65%, #fff)' },
  heat: { drift: [0.04, -0.6], grain: [20, 52], lean: 0, light: 'color-mix(in srgb, var(--risk-2) 40%, #fff3e0)' },
} as const

const motionOff = () =>
  document.documentElement.dataset['nxtMotion'] === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches

/** Resolves a CSS colour to 0…1 RGB through a probe, so tokens and `color-mix` follow the current theme. */
function resolveColor(host: Element, css: string): [number, number, number] {
  const probe = document.createElement('i')
  probe.style.color = css
  host.append(probe)
  const value = getComputedStyle(probe).color
  probe.remove()
  const channels = (value.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number)
  const [r = 0, g = 0, b = 0] = value.startsWith('color(') ? channels : channels.map((channel) => channel / 255)
  return [r, g, b]
}

export function runMaterial(canvas: HTMLCanvasElement, current: () => StepScaleMaterial | undefined): () => void {
  const gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false })
  if (gl === null) return () => undefined
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)
    if (shader === null) throw new Error('WebGL shader unavailable')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    return shader
  }
  const program = gl.createProgram()
  gl.attachShader(
    program,
    compile(gl.VERTEX_SHADER, 'attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }'),
  )
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return () => undefined
  gl.useProgram(program)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const position = gl.getAttribLocation(program, 'p')
  gl.enableVertexAttribArray(position)
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
  const uniform = (name: string) => gl.getUniformLocation(program, name)

  let visible = true
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true
  })
  observer.observe(canvas)
  const start = performance.now()
  let level = 0
  let frame = 0
  let colors: { key: string; from: number[]; to: number[]; lumen: number[]; light: number[] } | undefined
  let handle = requestAnimationFrame(function draw(now) {
    handle = requestAnimationFrame(draw)
    const material = current()
    const running = material !== undefined && visible && !document.hidden && !motionOff()
    level += ((running ? material.strength : 0) - level) * 0.08
    canvas.style.opacity = level > 0.01 ? '1' : '0'
    if (level <= 0.01 || material === undefined) return
    const look = LOOKS[material.kind]
    // Children of a canvas are not rendered, so colours are resolved on its parent, which inherits the tokens.
    const host = canvas.parentElement ?? document.body
    const style = getComputedStyle(host)
    const key = `${material.kind}|${style.getPropertyValue('--scale-from')}|${style.getPropertyValue('--scale-to')}`
    // Colours are re-read when the level changes and every second, which also follows a theme switch.
    if (colors?.key !== key || frame++ % 60 === 0) {
      colors = {
        key,
        from: resolveColor(host, 'var(--scale-from)'),
        to: resolveColor(host, 'var(--scale-to)'),
        lumen: resolveColor(host, 'var(--focus)'),
        light: resolveColor(host, look.light),
      }
    }
    const ratio = devicePixelRatio || 1
    const width = Math.round(canvas.clientWidth * ratio)
    const height = Math.round(canvas.clientHeight * ratio)
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    gl.viewport(0, 0, width, height)
    gl.uniform2f(uniform('size'), width, height)
    gl.uniform1f(uniform('time'), ((now - start) / 1000) * ratio)
    gl.uniform3fv(uniform('from'), colors.from)
    gl.uniform3fv(uniform('to'), colors.to)
    gl.uniform3fv(uniform('lumen'), colors.lumen)
    gl.uniform3fv(uniform('light'), colors.light)
    gl.uniform1f(uniform('strength'), level)
    gl.uniform2f(uniform('drift'), look.drift[0], look.drift[1])
    gl.uniform2f(uniform('grain'), look.grain[0], look.grain[1])
    gl.uniform1f(uniform('lean'), look.lean)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  })
  return () => {
    cancelAnimationFrame(handle)
    observer.disconnect()
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
