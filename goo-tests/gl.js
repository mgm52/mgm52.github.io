/* Shared WebGL harness for the gooey-shader isolation tests.
 *
 * Sets up a full-screen-triangle pass that runs one fragment shader with
 * the card drawn (via card.js) into a texture.  Animation is driven by a
 * FIXED dt per rendered frame, not wall-clock time, so the motion stays
 * smooth even when the page renders slowly under software WebGL — which
 * is how these clips get recorded.  Classic <script>; exposes window.GooGL.
 *
 * Uniforms handed to every fragment shader:
 *   uRes   vec2   render size in px
 *   uTime  float  frame * dt  (seconds-ish)
 *   uTex   sampler2D  the card, drawn centred on a transparent margin
 *   uCard  vec4   card rect in [0,1] uv space: (x, y, w, h), y down
 *   uCardR float  card corner radius in uv (x units)
 */
(function () {
  const VERT = `#version 300 es
  precision highp float;
  out vec2 vUv;
  void main(){
    // full-screen triangle
    vec2 p = vec2((gl_VertexID==1)?3.0:-1.0, (gl_VertexID==2)?3.0:-1.0);
    vUv = (p+1.0)*0.5;
    gl_Position = vec4(p,0.0,1.0);
  }`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      console.error('shader compile error:\n' + log);
      throw new Error('shader compile: ' + log);
    }
    return s;
  }

  // fragSrc must declare its own `in vec2 vUv;` and `out vec4 frag;` plus
  // the uniforms it uses.  opts: { dt, w, h, seed, cardFrac, duration }.
  window.GooGL = {
    start(fragSrc, opts) {
      opts = opts || {};
      const W = opts.w || 760, H = opts.h || 950;
      const dt = opts.dt != null ? opts.dt : 0.04;

      const canvas = document.getElementById('gl');
      canvas.width = W; canvas.height = H;

      // Card texture, drawn at render resolution, centred.
      const tex2d = document.createElement('canvas');
      tex2d.width = W; tex2d.height = H;
      const rect = window.drawGooCard(tex2d, { seed: opts.seed, cardFrac: opts.cardFrac });

      const gl = canvas.getContext('webgl2', { antialias: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
      if (!gl) { document.title = 'NO_WEBGL2'; return; }

      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error('link error:\n' + gl.getProgramInfoLog(prog));
        document.title = 'LINK_FAIL';
        return;
      }
      gl.useProgram(prog);

      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tex2d);

      const uRes = gl.getUniformLocation(prog, 'uRes');
      const uTime = gl.getUniformLocation(prog, 'uTime');
      const uTex = gl.getUniformLocation(prog, 'uTex');
      const uCard = gl.getUniformLocation(prog, 'uCard');
      const uCardR = gl.getUniformLocation(prog, 'uCardR');

      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);

      // Draw one frame at animation time t (seconds-ish).
      function drawAt(t) {
        gl.viewport(0, 0, W, H);
        gl.useProgram(prog);
        gl.bindVertexArray(vao);
        if (uRes) gl.uniform2f(uRes, W, H);
        if (uTime) gl.uniform1f(uTime, t);
        if (uTex) gl.uniform1i(uTex, 0);
        if (uCard) gl.uniform4f(uCard, rect.x / W, rect.y / H, rect.w / W, rect.h / H);
        if (uCardR) gl.uniform1f(uCardR, rect.r / W);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.finish();
      }

      // Two ways to drive it:
      //  • live  — a free-running rAF loop (open the page in a browser);
      //  • seek  — the recorder stops the loop and steps frames by hand
      //            (window.GOO.seek), so every captured frame is deterministic
      //            and the clip stays smooth no matter how slow the GPU is.
      let frame = 0, raf = 0, live = true;
      window.__gooFrame = 0;
      function loop() {
        if (!live) return;
        drawAt(frame * dt);
        frame++; window.__gooFrame = frame;
        raf = requestAnimationFrame(loop);
      }
      window.GOO = {
        ready: false,
        dt,
        stop() { live = false; if (raf) cancelAnimationFrame(raf); },
        seek(t) { drawAt(t); },
      };
      requestAnimationFrame(() => { loop(); window.GOO.ready = true; document.title = 'GOO_READY'; });
    },
  };
})();
