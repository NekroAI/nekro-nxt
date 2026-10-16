import {
  Color,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'

/*
 * The moon-tide flow behind low-frequency pages (05 §2.2, §11.5): domain-warped noise in the theme's own colours, a
 * slow drift, and a soft lens that follows the pointer. Loaded on demand so ordinary pages never fetch three.js.
 */

const vertexShader = /* glsl */ `
  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec2 uPointer;
  uniform float uStrength;
  uniform vec3 uBase;
  uniform vec3 uTide;
  uniform vec3 uGlow;
  uniform vec3 uSheen;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    mat2 rotate = mat2(1.6, 1.2, -1.2, 1.6);
    for (int i = 0; i < 4; i++) {
      value += amplitude * noise(p);
      p = rotate * p;
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    float scale = min(uResolution.x, uResolution.y);
    vec2 p = (gl_FragCoord.xy - 0.5 * uResolution) / scale;
    vec2 pointer = (uPointer - 0.5) * uResolution / scale;
    float distanceToPointer = length(p - pointer);
    p += (p - pointer) * 0.12 * exp(-distanceToPointer * 2.6);

    float t = uTime * 0.03;
    // Broad, slow forms: two warps over low-frequency noise read as liquid, not as grain.
    vec2 q = vec2(fbm(p * 0.75 + t), fbm(p * 0.75 - t + 3.1));
    vec2 r = vec2(fbm(p * 0.9 + 1.6 * q + vec2(1.7, 9.2) + t * 1.2), fbm(p * 0.9 + 1.6 * q + vec2(8.3, 2.8) - t));
    float f = fbm(p * 0.7 + 1.8 * r);

    vec3 color = uBase;
    float tide = smoothstep(0.35, 0.8, f);
    color = mix(color, uTide, tide * uStrength);
    // A soft light from the upper right, where the page's glow token sits.
    float light = smoothstep(1.2, 0.0, length(p - vec2(0.55, 0.35)));
    color = mix(color, uGlow, (0.25 + 0.45 * smoothstep(0.4, 0.9, length(r))) * light * uStrength);
    // A fainter tide light from the lower left keeps the far side of a wide banner from going flat.
    float ebb = smoothstep(1.4, 0.0, length(p - vec2(-0.8, -0.45)));
    color = mix(color, uTide, ebb * 0.35 * uStrength);
    // A soft specular sheen on the crests of the flow.
    color += uSheen * pow(smoothstep(0.55, 0.95, f), 3.0) * 0.22 * uStrength;
    gl_FragColor = vec4(color, 1.0);
  }
`

export interface AmbientScene {
  readonly resize: () => void
  readonly setColors: () => void
  readonly setPointer: (x: number, y: number) => void
  readonly render: (seconds: number) => void
  readonly dispose: () => void
}

const token = (element: Element, name: string, fallback: string): Color => {
  const value = getComputedStyle(element).getPropertyValue(name).trim()
  try {
    return new Color(value || fallback)
  } catch {
    return new Color(fallback)
  }
}

export function createAmbientScene(canvas: HTMLCanvasElement): AmbientScene {
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
  const scene = new Scene()
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const uniforms = {
    uTime: { value: 0 },
    uResolution: { value: new Vector2(1, 1) },
    uPointer: { value: new Vector2(0.72, 0.4) },
    uStrength: { value: 0.6 },
    uBase: { value: new Vector3() },
    uTide: { value: new Vector3() },
    uGlow: { value: new Vector3() },
    uSheen: { value: new Vector3() },
  }
  const material = new ShaderMaterial({ vertexShader, fragmentShader, uniforms })
  const geometry = new PlaneGeometry(2, 2)
  scene.add(new Mesh(geometry, material))
  const pointer = new Vector2(0.72, 0.4)

  // The shader writes its output unconverted, so colours go in as the sRGB values the page tokens name.
  const rgb = { r: 0, g: 0, b: 0 }
  const setColor = (target: Vector3, color: Color) => {
    color.getRGB(rgb, SRGBColorSpace)
    target.set(rgb.r, rgb.g, rgb.b)
  }

  return {
    resize() {
      const { clientWidth, clientHeight } = canvas
      renderer.setSize(clientWidth, clientHeight, false)
      uniforms.uResolution.value.set(clientWidth * renderer.getPixelRatio(), clientHeight * renderer.getPixelRatio())
    },
    setColors() {
      setColor(uniforms.uBase.value, token(canvas, '--ambient-base', '#0b1524'))
      setColor(uniforms.uTide.value, token(canvas, '--ambient-tide', '#4a6aa8'))
      setColor(uniforms.uGlow.value, token(canvas, '--ambient-glow', '#6bc3f4'))
      setColor(uniforms.uSheen.value, token(canvas, '--ambient-sheen', '#eef2f8'))
      const strength = Number.parseFloat(getComputedStyle(canvas).getPropertyValue('--ambient-strength'))
      uniforms.uStrength.value = Number.isFinite(strength) ? strength : 0.6
    },
    setPointer(x, y) {
      pointer.set(x, y)
    },
    render(seconds) {
      // The lens eases toward the pointer instead of jumping to it.
      uniforms.uPointer.value.lerp(pointer, 0.06)
      uniforms.uTime.value = seconds
      renderer.render(scene, camera)
    },
    dispose() {
      geometry.dispose()
      material.dispose()
      renderer.dispose()
    },
  }
}
