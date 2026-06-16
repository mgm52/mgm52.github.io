// ─── The living iridescent field behind the Confluence ───────────────
// A WebGL metaball field that fills the trading realm: soft opaline blobs
// drift and merge over a luminous near-white expanse, one blob trailing the
// cursor, the whole sheet reading like light through mother-of-pearl. The
// world-cards' frosted glass samples this moving colour through their
// backdrop-blur — that drifting iridescence under the stock is what makes
// the glass read as glass, and ties every surface to the same substance the
// traders are made of.
//
// Adapted from an iridescent-metaball shader study, retuned from a dark void
// to a high-key opaline palette (the realm stays mostly light). Trade and
// dive moments push a reactive `splash` impulse into the field, so the
// background fluid swells where the DOM exchange is happening — the confluence
// reaching past the glass.
//
// Pure presentation: no game state, no imports. cards.ts owns its lifecycle
// (startCardGoo when the realm mounts, splash on the big fluid moments). If
// WebGL is unavailable the canvas stays blank and the CSS #card-dream layer
// beneath carries the realm on its own.

const MAX_SPLASH = 4;

type GooState = {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  prog: WebGLProgram;
  loc: Record<string, WebGLUniformLocation | null>;
  raf: number;
  start: number;
  dpr: number;
  mouse: [number, number];
  haveMouse: boolean;
  reduced: boolean;
  splashes: { x: number; y: number; t0: number; hue: number; strength: number }[];
  onMove: (e: PointerEvent) => void;
  onResize: () => void;
  draw: (now: number) => void;
};

let S: GooState | null = null;

const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}';

const FRAG = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform vec2 u_mouse;
uniform float u_goo;
uniform float u_count;
uniform int u_nsplash;
uniform vec4 u_splash[${MAX_SPLASH}]; // xy = pos (uv space), z = age 0..1, w = hue

// Iridescent cosine palette — pastel, high-key, drifting lavender → aqua →
// rose → gold so the field reads as opal rather than rainbow.
vec3 pal(float t){
  vec3 a=vec3(0.60,0.59,0.66);
  vec3 b=vec3(0.36,0.34,0.38);
  vec3 c=vec3(1.0,1.0,1.0);
  vec3 d=vec3(0.0,0.16,0.40);
  return a+b*cos(6.28318*(c*t+d));
}

void main(){
  vec2 uv=(gl_FragCoord.xy-0.5*u_res)/u_res.y;
  float t=u_time*0.001;
  float field=0.0; vec2 grad=vec2(0.0);
  // Ambient drifting blobs.
  for(int i=0;i<8;i++){
    float fi=float(i);
    float on=step(fi+0.5,u_count);
    float a=fi*2.39996;
    vec2 c=vec2(
      sin(t*0.55+a)*0.66+sin(t*0.27+fi)*0.14,
      cos(t*0.48+a*1.27)*0.46+cos(t*0.23+fi)*0.14);
    float r=0.14+0.06*sin(t*0.8+fi*1.7);
    vec2 diff=uv-c; float d2=dot(diff,diff)+0.0009; float k=r*r/d2;
    field+=k*on; grad+=(-2.0*r*r*diff/(d2*d2))*on;
  }
  // The cursor blob — a soft pearl that follows the glove.
  vec2 m=(u_mouse-0.5*u_res)/u_res.y; vec2 dm=uv-m; float dm2=dot(dm,dm)+0.0009; float mr=0.15;
  field+=mr*mr/dm2; grad+=-2.0*mr*mr*dm/(dm2*dm2);
  // Splash impulses — transient swells pushed in by trades / dives. Each
  // grows then fades over its life (z = age 0..1).
  float splashHue=0.0; float splashW=0.0;
  for(int i=0;i<${MAX_SPLASH};i++){
    if(i>=u_nsplash) break;
    vec4 sp=u_splash[i];
    float age=sp.z;
    float life=1.0-age;
    float rr=(0.05+age*0.40);
    vec2 sc=sp.xy;
    vec2 ds=uv-sc; float ds2=dot(ds,ds)+0.0009;
    float kk=(rr*rr/ds2)*life*1.4;
    field+=kk; grad+=-2.0*rr*rr*ds/(ds2*ds2)*life*1.4;
    splashHue+=sp.w*kk; splashW+=kk;
  }

  float thr=u_goo;
  // Very wide smoothstep — the ambient field is atmosphere, not objects, so
  // the blobs are soft pearl WASHES with long diffuse edges, leaving the
  // crisp, defined metaballs to the traders in the foreground.
  float edge=smoothstep(thr*0.50,thr*1.75,field);
  vec2 g=normalize(grad+1e-5);
  vec3 N=normalize(vec3(g,2.6));
  vec3 L=normalize(vec3(0.4,0.7,0.9));
  float dif=clamp(dot(N,L),0.0,1.0);
  float spec=pow(dif,20.0)*0.28;

  // Hue drifts across space + time only — the raw metaball field is NOT fed
  // in (it diverges to infinity at each centre, which would spin the palette
  // into concentric rainbow rings). A gently-clamped field term adds just a
  // touch of depth toward the cores.
  float hue=uv.x*0.24+uv.y*0.11+t*0.04+min(field,2.5)*0.025;
  if(splashW>0.001) hue+=(splashHue/splashW)*0.16;
  vec3 base=pal(hue);
  // High-key opal: mostly white so the sheet stays luminous and the cards over
  // it read pearlescent, never murky. A soft fresnel rim picks up a shade more
  // colour at the blob edges (the oil-slick tell), but the bodies stay flat
  // and pale so the foreground traders own the eye.
  float rim=1.0-clamp(dif,0.0,1.0);
  vec3 col=mix(vec3(1.0), base, 0.28+0.16*rim);
  col=col*(0.90+0.16*dif)+spec*vec3(1.0,0.99,0.97);

  // The luminous near-white ground, with the faintest cool fall-off so the
  // expanse has depth without going grey.
  vec3 bg=mix(vec3(0.982,0.984,0.996), vec3(0.95,0.963,0.993), length(uv)*0.8);
  col=mix(bg,col,edge);
  // Outer halo — the soft colour leaking past each blob's edge.
  float halo=smoothstep(thr*0.20,thr*0.80,field)*(1.0-edge);
  col+=(pal(hue+0.4)-vec3(0.5))*halo*0.22;

  // Dither to kill banding on the gentle gradients.
  float dither=(fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453)-0.5)/255.0;
  col+=dither;
  gl_FragColor=vec4(col,1.0);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn('[card-goo] shader compile failed:', gl.getShaderInfoLog(s));
    return null;
  }
  return s;
}

export function startCardGoo(): void {
  if (S) return;
  const canvas = document.getElementById('card-goo') as HTMLCanvasElement | null;
  if (!canvas) return;
  const gl = (canvas.getContext('webgl', { antialias: true, premultipliedAlpha: false })
    || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
  if (!gl) return;

  const vs = compile(gl, gl.VERTEX_SHADER, VERT);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return;
  const prog = gl.createProgram();
  if (!prog) return;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.warn('[card-goo] link failed:', gl.getProgramInfoLog(prog));
    return;
  }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const pLoc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(pLoc);
  gl.vertexAttribPointer(pLoc, 2, gl.FLOAT, false, 0, 0);

  const loc: GooState['loc'] = {
    res: gl.getUniformLocation(prog, 'u_res'),
    time: gl.getUniformLocation(prog, 'u_time'),
    mouse: gl.getUniformLocation(prog, 'u_mouse'),
    goo: gl.getUniformLocation(prog, 'u_goo'),
    count: gl.getUniformLocation(prog, 'u_count'),
    nsplash: gl.getUniformLocation(prog, 'u_nsplash'),
    splash: gl.getUniformLocation(prog, 'u_splash'),
  };

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const st: GooState = {
    canvas, gl, prog, loc,
    raf: 0,
    start: performance.now(),
    dpr: Math.min(window.devicePixelRatio || 1, 2),
    mouse: [0, 0],
    haveMouse: false,
    reduced,
    splashes: [],
    onMove: () => { /* set below */ },
    onResize: () => { /* set below */ },
    draw: () => { /* set below */ },
  };

  const resize = (): void => {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.max(1, Math.floor(w * st.dpr));
    canvas.height = Math.max(1, Math.floor(h * st.dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
    if (!st.haveMouse) st.mouse = [canvas.width * 0.5, canvas.height * 0.62];
  };
  st.onResize = resize;

  const onMove = (e: PointerEvent): void => {
    const r = canvas.getBoundingClientRect();
    st.mouse = [(e.clientX - r.left) * st.dpr, (r.height - (e.clientY - r.top)) * st.dpr];
    st.haveMouse = true;
  };
  st.onMove = onMove;

  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', onMove, { passive: true });
  resize();

  // One shared draw. With motion parked the ambient time is frozen to a calm
  // settled value (a still opal), but splashes still bloom — so the loop keeps
  // running while any are alive and otherwise idles.
  const drawAndContinue = (now: number): void => {
    const live = st.splashes.filter((s) => now - s.t0 < s.strength);
    st.splashes = live;
    gl.uniform2f(loc.res, canvas.width, canvas.height);
    gl.uniform1f(loc.time, st.reduced ? 4200 : now - st.start);
    gl.uniform2f(loc.mouse, st.mouse[0], st.mouse[1]);
    gl.uniform1f(loc.goo, 0.95); // threshold ≈ gooeyness: lower → blobs merge sooner
    gl.uniform1f(loc.count, 7);
    const n = Math.min(live.length, MAX_SPLASH);
    gl.uniform1i(loc.nsplash, n);
    const arr = new Float32Array(MAX_SPLASH * 4);
    for (let i = 0; i < n; i++) {
      const s = live[i];
      arr[i * 4] = s.x;
      arr[i * 4 + 1] = s.y;
      arr[i * 4 + 2] = Math.min(1, (now - s.t0) / s.strength);
      arr[i * 4 + 3] = s.hue;
    }
    if (loc.splash) gl.uniform4fv(loc.splash, arr);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // Keep looping while moving, or while a splash is still blooming.
    st.raf = (!st.reduced || live.length > 0) ? requestAnimationFrame(drawAndContinue) : 0;
  };
  st.draw = drawAndContinue;
  st.raf = requestAnimationFrame(drawAndContinue);
  S = st;
}

// Push a reactive swell into the field at a screen point (client px). hue in
// 0..1 tints the swell; durMs is how long it blooms and fades.
export function splashCardGoo(clientX: number, clientY: number, hue = 0.5, durMs = 1400): void {
  const st = S;
  if (!st) return;
  const r = st.canvas.getBoundingClientRect();
  // Convert client px → the shader's uv space (centre origin, +y up, /height).
  const x = ((clientX - r.left) - r.width * 0.5) / r.height;
  const y = (r.height * 0.5 - (clientY - r.top)) / r.height;
  st.splashes.push({ x, y, t0: performance.now(), hue, strength: durMs });
  if (st.splashes.length > MAX_SPLASH) st.splashes.shift();
  // Re-arm the loop if it had idled (reduced motion parks it between splashes).
  if (!st.raf) st.raf = requestAnimationFrame(st.draw);
}

export function stopCardGoo(): void {
  const st = S;
  if (!st) return;
  if (st.raf) cancelAnimationFrame(st.raf);
  window.removeEventListener('resize', st.onResize);
  window.removeEventListener('pointermove', st.onMove);
  S = null;
}
