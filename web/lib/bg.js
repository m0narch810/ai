// The field behind the terminal: a slow, monochrome flow of noise on a WebGL canvas.
//
// One fragment shader, rendered at quarter resolution and scaled up (it is soft by design,
// so the upscale is invisible and the GPU cost is trivial). A tinted band drifts through
// a near-black field; the ice accent only ever appears as the faintest lift in the brightest
// fold. Reduced-motion viewers get a single still frame; hidden tabs stop the loop.
//
// Fallback when WebGL is unavailable: a static two-stop gradient, so the page never looks
// broken on a locked-down browser.

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

const FRAG = `
precision mediump float;
uniform vec2  uRes;
uniform float uT;
uniform float uDark;

// 2D simplex noise (Ashima / Ian McEwan), compact form.
vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec2 mod289(vec2 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec3 permute(vec3 x){ return mod289(((x*34.0)+1.0)*x); }
float snoise(vec2 v){
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz; x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
  m = m*m; m = m*m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
  vec3 g; g.x = a0.x * x0.x + h.x * x0.y; g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.55;
  for (int i = 0; i < 4; i++) { v += a * snoise(p); p = p * 2.03 + vec2(17.1, 9.7); a *= 0.5; }
  return v;
}
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  float ar = uRes.x / uRes.y;
  vec2 q = vec2(uv.x * ar, uv.y);
  float t = uT * 0.045;
  // two slow layers moving against each other = the "flow"
  float n1 = fbm(q * 1.15 + vec2(t * 0.35, -t * 0.22));
  float n2 = fbm(q * 0.7  - vec2(t * 0.18,  t * 0.27) + n1 * 0.35);
  float n = n1 * 0.6 + n2 * 0.4;               // ~[-1, 1]
  float lift = smoothstep(0.05, 0.85, n);      // only the brighter folds lift
  // vertical bias: brighter toward the top where the hero sits, fading down the page
  float vb = smoothstep(0.0, 1.0, uv.y) * 0.65 + 0.35;

  vec3 dark0 = vec3(0.019, 0.019, 0.027);
  vec3 dark1 = vec3(0.075, 0.082, 0.115);      // ice-tinted fold
  vec3 light0 = vec3(0.960, 0.960, 0.972);
  vec3 light1 = vec3(0.880, 0.905, 0.955);

  vec3 cD = mix(dark0, dark1, lift * vb);
  vec3 cL = mix(light0, light1, lift * vb * 0.9);
  vec3 c = mix(cL, cD, uDark);
  // very light grain so the gradient never bands
  float g = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  c += g * 0.012;
  gl_FragColor = vec4(c, 1.0);
}`;

const reduced = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const isDark = () => document.documentElement.dataset.theme !== "light";

export function initBackground(canvas) {
  if (!canvas) return null;
  const gl = canvas.getContext("webgl", { antialias: false, depth: false, stencil: false, alpha: false, powerPreference: "low-power" });
  if (!gl) return fallback(canvas);

  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, FRAG]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.warn("[bg]", gl.getShaderInfoLog(sh)); return fallback(canvas); }
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return fallback(canvas);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const uRes = gl.getUniformLocation(prog, "uRes");
  const uT = gl.getUniformLocation(prog, "uT");
  const uDark = gl.getUniformLocation(prog, "uDark");

  const SCALE = 0.28;                          // render at ~¼ res; it is soft noise
  let raf = 0, t0 = performance.now();

  function resize() {
    const w = Math.max(2, Math.round(window.innerWidth * SCALE));
    const h = Math.max(2, Math.round(window.innerHeight * SCALE));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
  }
  function draw(now) {
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uT, (now - t0) / 1000);
    gl.uniform1f(uDark, isDark() ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  function loop(now) {
    raf = requestAnimationFrame(loop);
    draw(now);
  }
  function start() { if (!raf && !reduced()) { raf = requestAnimationFrame(loop); } }
  function stop() { cancelAnimationFrame(raf); raf = 0; }
  function still() { stop(); draw(performance.now()); }

  resize();
  reduced() ? still() : start();

  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { resize(); if (reduced()) still(); }, 120); });
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : (reduced() ? still() : start())));

  return { repaint: () => { if (reduced() || document.hidden) still(); } };
}

function fallback(canvas) {
  const paint = () => {
    canvas.style.background = isDark()
      ? "radial-gradient(ellipse 80% 55% at 50% 0%, #111119 0%, #050507 70%)"
      : "radial-gradient(ellipse 80% 55% at 50% 0%, #e6ebf5 0%, #f5f5f8 70%)";
  };
  paint();
  return { repaint: paint };
}
