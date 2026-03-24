document.addEventListener("DOMContentLoaded", () => {
  const canvas = document.getElementById("fluid");
  // Configuration
  let config = {
    SIM_RESOLUTION: 128,
    DYE_RESOLUTION: 1024,
    CAPTURE_RESOLUTION: 512,
    DENSITY_DISSIPATION: 1,
    VELOCITY_DISSIPATION: 0.2,
    PRESSURE: 0.8,
    PRESSURE_ITERATIONS: 20,
    CURL: 30,
    SPLAT_RADIUS: 0.25,
    SPLAT_FORCE: 6000,
    SHADING: true,
    COLOR_UPDATE_SPEED: 10,
    PAUSED: false,
    BACK_COLOR: { r: 0, g: 0, b: 0 },
    TRANSPARENT: true,
  };
  // WebGL Helper Functions
  function getWebGLContext(canvas) {
    const params = {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: false,
    };
    let gl = canvas.getContext("webgl2", params);
    const isWebGL2 = !!gl;
    if (!isWebGL2)
      gl =
        canvas.getContext("webgl", params) ||
        canvas.getContext("experimental-webgl", params);
    let halfFloat;
    let supportLinearFiltering;
    if (isWebGL2) {
      gl.getExtension("EXT_color_buffer_float");
      supportLinearFiltering = gl.getExtension("OES_texture_float_linear");
    } else {
      halfFloat = gl.getExtension("OES_texture_half_float");
      supportLinearFiltering = gl.getExtension("OES_texture_half_float_linear");
    }
    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    const halfFloatTexType = isWebGL2
      ? gl.HALF_FLOAT
      : (halfFloat && halfFloat.HALF_FLOAT_OES) || gl.FLOAT;
    return { gl, ext: { halfFloatTexType, supportLinearFiltering } };
  }
  const { gl, ext } = getWebGLContext(canvas);
  function createShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw gl.getShaderInfoLog(shader);
    return shader;
  }
  function createProgram(vsSource, fsSource) {
    const program = gl.createProgram();
    gl.attachShader(program, createShader(gl.VERTEX_SHADER, vsSource));
    gl.attachShader(program, createShader(gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw gl.getProgramInfoLog(program);
    return program;
  }
  // Shaders
  const baseVertexShader = `
                precision highp float;
                attribute vec2 aPosition;
                varying vec2 vUv;
                varying vec2 vL;
                varying vec2 vR;
                varying vec2 vT;
                varying vec2 vB;
                uniform vec2 texelSize;
                void main () {
                    vUv = aPosition * 0.5 + 0.5;
                    vL = vUv - vec2(texelSize.x, 0.0);
                    vR = vUv + vec2(texelSize.x, 0.0);
                    vT = vUv + vec2(0.0, texelSize.y);
                    vB = vUv - vec2(0.0, texelSize.y);
                    gl_Position = vec4(aPosition, 0.0, 1.0);
                }
            `;
  const clearShader = `
                precision mediump float;
                precision mediump sampler2D;
                varying highp vec2 vUv;
                uniform sampler2D uTexture;
                uniform float value;
                void main () {
                    gl_FragColor = value * texture2D(uTexture, vUv);
                }
            `;
  const displayShaderSource = `
                precision highp float;
                precision highp sampler2D;
                varying vec2 vUv;
                varying vec2 vL;
                varying vec2 vR;
                varying vec2 vT;
                varying vec2 vB;
                uniform sampler2D uTexture;
                uniform sampler2D uDithering;
                uniform vec2 ditherScale;
                uniform vec2 texelSize;
                void main () {
                    vec3 c = texture2D(uTexture, vUv).rgb;
                    #ifdef SHADING
                        vec3 lc = texture2D(uTexture, vL).rgb;
                        vec3 rc = texture2D(uTexture, vR).rgb;
                        vec3 tc = texture2D(uTexture, vT).rgb;
                        vec3 bc = texture2D(uTexture, vB).rgb;
                        float dx = length(rc) - length(lc);
                        float dy = length(tc) - length(bc);
                        vec3 n = normalize(vec3(dx, dy, length(texelSize)));
                        vec3 l = vec3(0.0, 0.0, 1.0);
                        float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);
                        c *= diffuse;
                    #endif
                    float a = max(c.r, max(c.g, c.b));
                    gl_FragColor = vec4(c, a);
                }
            `;
  const splatShader = `
                precision highp float;
                precision highp sampler2D;
                varying vec2 vUv;
                uniform sampler2D uTarget;
                uniform float aspectRatio;
                uniform vec3 color;
                uniform vec2 point;
                uniform float radius;
                void main () {
                    vec2 p = vUv - point.xy;
                    p.x *= aspectRatio;
                    vec3 splat = exp(-dot(p, p) / radius) * color;
                    vec3 base = texture2D(uTarget, vUv).xyz;
                    gl_FragColor = vec4(base + splat, 1.0);
                }
            `;
  const advectionShader = `
                precision highp float;
                precision highp sampler2D;
                varying vec2 vUv;
                uniform sampler2D uVelocity;
                uniform sampler2D uSource;
                uniform vec2 texelSize;
                uniform vec2 dyeTexelSize;
                uniform float dt;
                uniform float dissipation;
                vec4 bilerp (sampler2D sam, vec2 uv, vec2 tsize) {
                    vec2 st = uv / tsize - 0.5;
                    vec2 iuv = floor(st);
                    vec2 fuv = fract(st);
                    vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
                    vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
                    vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
                    vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
                    return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
                }
                void main () {
                    vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
                    vec4 result = texture2D(uSource, coord);
                    float decay = 1.0 + dissipation * dt;
                    gl_FragColor = result / decay;
                }
            `;
  const divergenceShader = `
                precision mediump float;
                precision mediump sampler2D;
                varying highp vec2 vUv;
                varying highp vec2 vL;
                varying highp vec2 vR;
                varying highp vec2 vT;
                varying highp vec2 vB;
                uniform sampler2D uVelocity;
                void main () {
                    float L = texture2D(uVelocity, vL).x;
                    float R = texture2D(uVelocity, vR).x;
                    float T = texture2D(uVelocity, vT).y;
                    float B = texture2D(uVelocity, vB).y;
                    vec2 C = texture2D(uVelocity, vUv).xy;
                    if (vL.x < 0.0) { L = -C.x; }
                    if (vR.x > 1.0) { R = -C.x; }
                    if (vT.y > 1.0) { T = -C.y; }
                    if (vB.y < 0.0) { B = -C.y; }
                    float div = 0.5 * (R - L + T - B);
                    gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
                }
            `;
  const curlShader = `
                precision mediump float;
                precision mediump sampler2D;
                varying highp vec2 vUv;
                varying highp vec2 vL;
                varying highp vec2 vR;
                varying highp vec2 vT;
                varying highp vec2 vB;
                uniform sampler2D uVelocity;
                void main () {
                    float L = texture2D(uVelocity, vL).y;
                    float R = texture2D(uVelocity, vR).y;
                    float T = texture2D(uVelocity, vT).x;
                    float B = texture2D(uVelocity, vB).x;
                    float vorticity = R - L - T + B;
                    gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
                }
            `;
  const vorticityShader = `
                precision highp float;
                precision highp sampler2D;
                varying vec2 vUv;
                varying vec2 vL;
                varying vec2 vR;
                varying vec2 vT;
                varying vec2 vB;
                uniform sampler2D uVelocity;
                uniform sampler2D uCurl;
                uniform float curl;
                uniform float dt;
                void main () {
                    float L = texture2D(uCurl, vL).x;
                    float R = texture2D(uCurl, vR).x;
                    float T = texture2D(uCurl, vT).x;
                    float B = texture2D(uCurl, vB).x;
                    float C = texture2D(uCurl, vUv).x;
                    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
                    force /= length(force) + 0.0001;
                    force *= curl * C;
                    force.y *= -1.0;
                    vec2 velocity = texture2D(uVelocity, vUv).xy;
                    velocity += force * dt;
                    velocity = min(max(velocity, -1000.0), 1000.0);
                    gl_FragColor = vec4(velocity, 0.0, 1.0);
                }
            `;
  const pressureShader = `
                precision mediump float;
                precision mediump sampler2D;
                varying highp vec2 vUv;
                varying highp vec2 vL;
                varying highp vec2 vR;
                varying highp vec2 vT;
                varying highp vec2 vB;
                uniform sampler2D uPressure;
                uniform sampler2D uDivergence;
                void main () {
                    float L = texture2D(uPressure, vL).x;
                    float R = texture2D(uPressure, vR).x;
                    float T = texture2D(uPressure, vT).x;
                    float B = texture2D(uPressure, vB).x;
                    float C = texture2D(uPressure, vUv).x;
                    float divergence = texture2D(uDivergence, vUv).x;
                    float pressure = (L + R + B + T - divergence) * 0.25;
                    gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
                }
            `;
  const gradientSubtractShader = `
                precision mediump float;
                precision mediump sampler2D;
                varying highp vec2 vUv;
                varying highp vec2 vL;
                varying highp vec2 vR;
                varying highp vec2 vT;
                varying highp vec2 vB;
                uniform sampler2D uPressure;
                uniform sampler2D uVelocity;
                void main () {
                    float L = texture2D(uPressure, vL).x;
                    float R = texture2D(uPressure, vR).x;
                    float T = texture2D(uPressure, vT).x;
                    float B = texture2D(uPressure, vB).x;
                    vec2 velocity = texture2D(uVelocity, vUv).xy;
                    velocity.xy -= vec2(R - L, T - B);
                    gl_FragColor = vec4(velocity, 0.0, 1.0);
                }
            `;
  // Programs
  const splatProgram = createProgram(baseVertexShader, splatShader);
  const curlProgram = createProgram(baseVertexShader, curlShader);
  const vorticityProgram = createProgram(baseVertexShader, vorticityShader);
  const divergenceProgram = createProgram(baseVertexShader, divergenceShader);
  const clearProgram = createProgram(baseVertexShader, clearShader);
  const pressureProgram = createProgram(baseVertexShader, pressureShader);
  const gradientSubtractProgram = createProgram(
    baseVertexShader,
    gradientSubtractShader,
  );
  const advectionProgram = createProgram(baseVertexShader, advectionShader);
  const displayProgram = createProgram(baseVertexShader, displayShaderSource); // Need to attach keywords for shading
  // Uniforms
  function getUniforms(program) {
    let uniforms = {};
    let uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < uniformCount; i++) {
      let uniformName = gl.getActiveUniform(program, i).name;
      uniforms[uniformName] = gl.getUniformLocation(program, uniformName);
    }
    return uniforms;
  }
  const programs = [
    splatProgram,
    curlProgram,
    vorticityProgram,
    divergenceProgram,
    clearProgram,
    pressureProgram,
    gradientSubtractProgram,
    advectionProgram,
    displayProgram,
  ];
  programs.forEach((p) => (p.uniforms = getUniforms(p)));
  // FBO Helpers
  function createFBO(w, h, internalFormat, format, type, param) {
    gl.activeTexture(gl.TEXTURE0);
    let texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      internalFormat,
      w,
      h,
      0,
      format,
      type,
      null,
    );
    let fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0,
    );
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return {
      texture,
      fbo,
      width: w,
      height: h,
      texelSizeX: 1.0 / w,
      texelSizeY: 1.0 / h,
      attach: (id) => {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      },
    };
  }
  function createDoubleFBO(w, h, internalFormat, format, type, param) {
    let fbo1 = createFBO(w, h, internalFormat, format, type, param);
    let fbo2 = createFBO(w, h, internalFormat, format, type, param);
    return {
      width: w,
      height: h,
      texelSizeX: fbo1.texelSizeX,
      texelSizeY: fbo1.texelSizeY,
      get read() {
        return fbo1;
      },
      set read(value) {
        fbo1 = value;
      },
      get write() {
        return fbo2;
      },
      set write(value) {
        fbo2 = value;
      },
      swap() {
        let temp = fbo1;
        fbo1 = fbo2;
        fbo2 = temp;
      },
    };
  }
  // Init FBOs
  let dye, velocity, divergence, curl, pressure;
  function initFramebuffers() {
    let simRes = getResolution(config.SIM_RESOLUTION);
    let dyeRes = getResolution(config.DYE_RESOLUTION);
    const texType = ext.halfFloatTexType;
    const rgba = gl.RGBA;
    const rg = gl.RG || gl.RGBA; // Fallback
    const r = gl.RED || gl.RGBA; // Fallback
    // For WebGL1 or fallbacks, we might need adjustments, simplified here for space
    const formatRGBA = {
      internalFormat: gl.RGBA16F || gl.RGBA,
      format: gl.RGBA,
    };
    const formatRG = {
      internalFormat: gl.RG16F || gl.RGBA,
      format: gl.RG || gl.RGBA,
    };
    const formatR = {
      internalFormat: gl.R16F || gl.RGBA,
      format: gl.RED || gl.RGBA,
    };
    dye = createDoubleFBO(
      dyeRes.width,
      dyeRes.height,
      formatRGBA.internalFormat,
      formatRGBA.format,
      texType,
      gl.LINEAR,
    );
    velocity = createDoubleFBO(
      simRes.width,
      simRes.height,
      formatRG.internalFormat,
      formatRG.format,
      texType,
      gl.LINEAR,
    );
    divergence = createFBO(
      simRes.width,
      simRes.height,
      formatR.internalFormat,
      formatR.format,
      texType,
      gl.NEAREST,
    );
    curl = createFBO(
      simRes.width,
      simRes.height,
      formatR.internalFormat,
      formatR.format,
      texType,
      gl.NEAREST,
    );
    pressure = createDoubleFBO(
      simRes.width,
      simRes.height,
      formatR.internalFormat,
      formatR.format,
      texType,
      gl.NEAREST,
    );
  }
  function getResolution(resolution) {
    let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspectRatio < 1) aspectRatio = 1.0 / aspectRatio;
    let min = Math.round(resolution);
    let max = Math.round(resolution * aspectRatio);
    if (gl.drawingBufferWidth > gl.drawingBufferHeight)
      return { width: max, height: min };
    else return { width: min, height: max };
  }
  function blit(target) {
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  // Quad buffer
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]),
    gl.STATIC_DRAW,
  );
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);
  function update() {
    resizeCanvas();
    const dt = Math.min((Date.now() - lastUpdateTime) / 1000, 0.016);
    lastUpdateTime = Date.now();
    gl.disable(gl.BLEND);
    // CURL
    gl.useProgram(curlProgram);
    gl.uniform2f(
      curlProgram.uniforms.texelSize,
      velocity.texelSizeX,
      velocity.texelSizeY,
    );
    gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(curl);
    // VORTICITY
    gl.useProgram(vorticityProgram);
    gl.uniform2f(
      vorticityProgram.uniforms.texelSize,
      velocity.texelSizeX,
      velocity.texelSizeY,
    );
    gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProgram.uniforms.uCurl, curl.attach(1));
    gl.uniform1f(vorticityProgram.uniforms.curl, config.CURL);
    gl.uniform1f(vorticityProgram.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();
    // DIVERGENCE
    gl.useProgram(divergenceProgram);
    gl.uniform2f(
      divergenceProgram.uniforms.texelSize,
      velocity.texelSizeX,
      velocity.texelSizeY,
    );
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergence);
    // CLEAR
    gl.useProgram(clearProgram);
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, config.PRESSURE);
    blit(pressure.write);
    pressure.swap();
    // PRESSURE
    gl.useProgram(pressureProgram);
    gl.uniform2f(
      pressureProgram.uniforms.texelSize,
      velocity.texelSizeX,
      velocity.texelSizeY,
    );
    gl.uniform1i(pressureProgram.uniforms.uDivergence, divergence.attach(0));
    for (let i = 0; i < config.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write);
      pressure.swap();
    }
    // GRADIENT SUBTRACT
    gl.useProgram(gradientSubtractProgram);
    gl.uniform2f(
      gradientSubtractProgram.uniforms.texelSize,
      velocity.texelSizeX,
      velocity.texelSizeY,
    );
    gl.uniform1i(
      gradientSubtractProgram.uniforms.uPressure,
      pressure.read.attach(0),
    );
    gl.uniform1i(
      gradientSubtractProgram.uniforms.uVelocity,
      velocity.read.attach(1),
    );
    blit(velocity.write);
    velocity.swap();
    // ADVECTION
    gl.useProgram(advectionProgram);
    gl.uniform2f(
      advectionProgram.uniforms.texelSize,
      velocity.texelSizeX,
      velocity.texelSizeY,
    );
    gl.uniform2f(
      advectionProgram.uniforms.dyeTexelSize,
      velocity.texelSizeX,
      velocity.texelSizeY,
    );
    let velocityId = velocity.read.attach(0);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocityId);
    gl.uniform1i(advectionProgram.uniforms.uSource, velocityId);
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(
      advectionProgram.uniforms.dissipation,
      config.VELOCITY_DISSIPATION,
    );
    blit(velocity.write);
    velocity.swap();
    gl.uniform2f(
      advectionProgram.uniforms.dyeTexelSize,
      dye.texelSizeX,
      dye.texelSizeY,
    );
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(
      advectionProgram.uniforms.dissipation,
      config.DENSITY_DISSIPATION,
    );
    blit(dye.write);
    dye.swap();
    // DISPLAY
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(displayProgram);
    gl.uniform1i(displayProgram.uniforms.uTexture, dye.read.attach(0));
    if (config.SHADING) {
      gl.uniform2f(
        displayProgram.uniforms.texelSize,
        1.0 / gl.drawingBufferWidth,
        1.0 / gl.drawingBufferHeight,
      );
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    requestAnimationFrame(update);
  }
  function resizeCanvas() {
    let width = window.innerWidth;
    let height = window.innerHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      initFramebuffers();
    }
  }
  function splat(x, y, dx, dy, color) {
    gl.useProgram(splatProgram);
    gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(
      splatProgram.uniforms.aspectRatio,
      canvas.width / canvas.height,
    );
    gl.uniform2f(
      splatProgram.uniforms.point,
      x / canvas.width,
      1.0 - y / canvas.height,
    );
    gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0.0);
    gl.uniform1f(splatProgram.uniforms.radius, config.SPLAT_RADIUS / 100.0);
    blit(velocity.write);
    velocity.swap();
    gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
    blit(dye.write);
    dye.swap();
  }
  let lastUpdateTime = Date.now();
  initFramebuffers();
  update();
  // Interactions
  window.addEventListener("mousemove", (e) => {
    splat(e.clientX, e.clientY, e.movementX * 10, -e.movementY * 10, {
      r: 0.2,
      g: 0.4,
      b: 1.0,
    });
  });
  window.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    splat(t.clientX, t.clientY, 10, 10, { r: 0.2, g: 0.4, b: 1.0 });
  });
  // Initial Splat
  splat(window.innerWidth / 2, window.innerHeight / 2, 0, -20, {
    r: 0.5,
    g: 0.5,
    b: 0.5,
  });

  // THEME TOGGLE LOGIC
  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme');
      const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', nextTheme);
      localStorage.setItem('theme', nextTheme);
    });
  }
});
!(function () {
  var f = [
      "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/917d6f93-fb36-439a-8c48-884b67b35381_1600w.jpg",
      "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/4734259a-bad7-422f-981e-ce01e79184f2_1600w.jpg",
      "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/c543a9e1-f226-4ced-80b0-feb8445a75b9_1600w.jpg",
      "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/5bab247f-35d9-400d-a82b-fd87cfe913d2_1600w.webp",
      "https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/30104e3c-5eea-4b93-93e9-5313698a7156_1600w.webp",
    ],
    h = new Set();
  function g(s) {
    for (var x = 0, i = 0; i < s.length; i++)
      x = ((x << 5) - x + s.charCodeAt(i)) | 0;
    return f[Math.abs(x) % f.length];
  }
  function r(t) {
    var s = t.src;
    if (s && !h.has(s)) {
      h.add(s);
      t.src = g(s);
    }
  }
  window.addEventListener(
    "error",
    function (e) {
      var t = e.target;
      if (t && t.tagName === "IMG") r(t);
    },
    !0,
  );
  function c() {
    document.querySelectorAll("img").forEach(function (i) {
      if (i.complete && !i.naturalWidth && i.src) r(i);
    });
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", c);
  else c();
})();

/* SCRIPT BOTÃO DE VOLTA AO TOPO */
window.addEventListener("scroll", function () {
  const btn = document.getElementById("btn-topo");
  if (btn) {
    if (document.body.scrollTop > 300 || document.documentElement.scrollTop > 300) {
      btn.style.display = "flex";
    } else {
      btn.style.display = "none";
    }
  }
});
