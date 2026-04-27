// WebGL2 Pipeline class — Plan 3 M2.1.
//
// Compiles five GLSL ES 3.0 fragment shaders into a five-pass chain:
// fp16 input -> WhiteBalance -> SceneToneControls -> SceneVibrance ->
// SceneSaturation -> AgXViewTransform -> 8-bit sRGB canvas.
//
// Two RGBA16F textures act as ping-pong attachments. AgX uses the
// inline 6-piece polynomial (per ticket #08, Apple commit 8ff4142) —
// no LUT image is uploaded; Plan 3 M2.1 Task 8 (LUT bundle) is skipped.
//
// Hard-requires fp16 — `Pipeline.create` throws WebglFp16Unsupported
// when EXT_color_buffer_half_float or OES_texture_float_linear is
// missing. M3 wraps construction in a try/catch for the production
// fallback path.
//
// The constants embedded in the shader sources MUST stay in sync with
// the corresponding Apple Metal kernels and the Rust raw-core helpers.
// M2.3 introduces a codegen scaffold (src/scripts/codegen/); until
// then, drift is caught by the snapshot test in pipeline.spec.ts.

import type { AdjustmentModel } from '../models/adjustment-model';
import type { DecodedSceneLinearImage } from '../raw-pipeline/raw-pipeline.types';
import { SHADERS } from './shaders/index';

export class WebglFp16Unsupported extends Error {
  constructor(missing: string[]) {
    super(
      `Maple WebGL2 dev-chain requires fp16 extensions: ` +
        `[${missing.join(', ')}] not present. ` +
        `M3 will add a fallback; M2.1 hard-requires.`,
    );
    this.name = 'WebglFp16Unsupported';
  }
}

interface ProgramHandles {
  program: WebGLProgram;
  uSrc: WebGLUniformLocation;
  uniforms: Record<string, WebGLUniformLocation>;
}

export class Pipeline {
  private gl: WebGL2RenderingContext;
  private programs: {
    whiteBalance: ProgramHandles;
    sceneToneControls: ProgramHandles;
    sceneVibrance: ProgramHandles;
    sceneSaturation: ProgramHandles;
    agxViewTransform: ProgramHandles;
  };
  private inputTex: WebGLTexture;
  private pingTex: WebGLTexture;
  private pongTex: WebGLTexture;
  private pingFb: WebGLFramebuffer;
  private pongFb: WebGLFramebuffer;
  private vao: WebGLVertexArrayObject;

  // Created via the static factory so async setup hooks (if any) can run
  // before the first render. Private constructor enforces the factory.
  private constructor(
    gl: WebGL2RenderingContext,
    progs: Pipeline['programs'],
    inputTex: WebGLTexture,
    pingTex: WebGLTexture,
    pongTex: WebGLTexture,
    pingFb: WebGLFramebuffer,
    pongFb: WebGLFramebuffer,
    vao: WebGLVertexArrayObject,
  ) {
    this.gl = gl;
    this.programs = progs;
    this.inputTex = inputTex;
    this.pingTex = pingTex;
    this.pongTex = pongTex;
    this.pingFb = pingFb;
    this.pongFb = pongFb;
    this.vao = vao;
  }

  /**
   * Create a Pipeline bound to the given canvas. Throws WebglFp16Unsupported
   * if EXT_color_buffer_half_float or OES_texture_float_linear is missing.
   *
   * The canvas is tagged with `colorSpace: 'display-p3'` so wide-gamut
   * browsers (P3 Macs / iPads / iPhones) display the wider color volume
   * the scene-linear chain produces, instead of clipping to the sRGB
   * primary triangle. The previous `'srgb'` tag was a workaround for
   * pre-P3 ramp-up — Apple platforms now consistently honor 'display-p3',
   * and CSS Color 4 mandates it as a valid value. On non-P3 displays the
   * browser tone-maps cleanly — no regression.
   *
   * Mirrors the Apple-side change in FullImageView.CIImageView (sRGB 8-bit
   * → Display P3 16-bit) so both platforms render to the same color
   * volume. See the matching docstring there for the full rationale.
   */
  static async create(canvas: HTMLCanvasElement): Promise<Pipeline> {
    // The WebGL2RenderingContextAttributes typings (DOM lib) include
    // `colorSpace` since recent TS, but Angular's narrower lib bundle
    // surfaces the canvas's broad `RenderingContext` union. Cast through
    // unknown so the option object can carry `colorSpace: 'display-p3'`
    // without TS narrowing complaints.
    const gl = canvas.getContext(
      'webgl2',
      {
        antialias: false,
        premultipliedAlpha: false,
        // M3 will flip back to `false` when the pipeline drives the
        // production canvas (per CLAUDE.md no-allocation render-loop
        // budget). M2.1's dev page needs the buffer to persist after
        // render so the human-eyeballable canvas matches the readPixels
        // output the snapshot tests assert against.
        preserveDrawingBuffer: true,
        colorSpace: 'display-p3',
      } as WebGLContextAttributes,
    ) as WebGL2RenderingContext | null;
    if (!gl) {
      throw new WebglFp16Unsupported(['WebGL2']);
    }
    const missing: string[] = [];
    if (!gl.getExtension('EXT_color_buffer_half_float')) {
      missing.push('EXT_color_buffer_half_float');
    }
    if (!gl.getExtension('OES_texture_float_linear')) {
      missing.push('OES_texture_float_linear');
    }
    if (missing.length > 0) {
      throw new WebglFp16Unsupported(missing);
    }

    const progs = {
      whiteBalance: linkProgram(gl, SHADERS.vertex, SHADERS.whiteBalance, [
        'uLiveTemperature',
        'uLiveTint',
        'uDecodedTemperature',
        'uDecodedTint',
      ]),
      sceneToneControls: linkProgram(
        gl,
        SHADERS.vertex,
        SHADERS.sceneToneControls,
        ['uExposure', 'uHighlights', 'uShadows', 'uWhites', 'uBlacks'],
      ),
      sceneVibrance: linkProgram(gl, SHADERS.vertex, SHADERS.sceneVibrance, [
        'uVibrance',
      ]),
      sceneSaturation: linkProgram(gl, SHADERS.vertex, SHADERS.sceneSaturation, [
        'uSaturation',
      ]),
      agxViewTransform: linkProgram(
        gl,
        SHADERS.vertex,
        SHADERS.agxViewTransform,
        ['uContrast'],
      ),
    };

    const inputTex = createFp16Texture(gl);
    const pingTex = createFp16Texture(gl);
    const pongTex = createFp16Texture(gl);
    const pingFb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, pingFb);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      pingTex,
      0,
    );
    const pongFb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, pongFb);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      pongTex,
      0,
    );

    // Empty VAO — gl_VertexID-driven full-screen triangle (vertex.glsl).
    const vao = gl.createVertexArray()!;
    return new Pipeline(
      gl,
      progs,
      inputTex,
      pingTex,
      pongTex,
      pingFb,
      pongFb,
      vao,
    );
  }

  /**
   * Run the five-shader chain on `input` with `model` parameters.
   * Resizes the ping-pong attachments to (input.width, input.height)
   * the first call (and on size changes). Renders the final pass to
   * the canvas backbuffer; returns the RGBA8 readback for the
   * snapshot test in Task 10.
   */
  render(input: DecodedSceneLinearImage, model: AdjustmentModel): Uint8ClampedArray {
    const gl = this.gl;
    const { width: w, height: h, fp16Rgba } = input;

    // Upload input fp16 RGBA -> inputTex.
    gl.bindTexture(gl.TEXTURE_2D, this.inputTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA16F,
      w,
      h,
      0,
      gl.RGBA,
      gl.HALF_FLOAT,
      fp16Rgba,
    );

    // Resize ping/pong if size changed (or initialise first run).
    gl.bindTexture(gl.TEXTURE_2D, this.pingTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, this.pongTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);

    gl.canvas.width = w;
    gl.canvas.height = h;
    gl.bindVertexArray(this.vao);

    // Pass 1: WhiteBalance -> ping
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pingFb);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.programs.whiteBalance.program);
    bindSrcTexture(gl, this.programs.whiteBalance, this.inputTex);
    gl.uniform1f(
      this.programs.whiteBalance.uniforms['uLiveTemperature'],
      model.temperature,
    );
    gl.uniform1f(this.programs.whiteBalance.uniforms['uLiveTint'], model.tint);
    // Decoded WB == as-shot at the time this Pipeline runs; the test page
    // wires those values from DecodedSceneLinearImage.asShotTemperature/Tint.
    gl.uniform1f(
      this.programs.whiteBalance.uniforms['uDecodedTemperature'],
      input.asShotTemperature,
    );
    gl.uniform1f(
      this.programs.whiteBalance.uniforms['uDecodedTint'],
      input.asShotTint,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 2: SceneToneControls (ping -> pong)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pongFb);
    gl.useProgram(this.programs.sceneToneControls.program);
    bindSrcTexture(gl, this.programs.sceneToneControls, this.pingTex);
    gl.uniform1f(
      this.programs.sceneToneControls.uniforms['uExposure'],
      model.exposure,
    );
    gl.uniform1f(
      this.programs.sceneToneControls.uniforms['uHighlights'],
      model.highlights,
    );
    gl.uniform1f(
      this.programs.sceneToneControls.uniforms['uShadows'],
      model.shadows,
    );
    gl.uniform1f(this.programs.sceneToneControls.uniforms['uWhites'], model.whites);
    gl.uniform1f(this.programs.sceneToneControls.uniforms['uBlacks'], model.blacks);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 3: SceneVibrance (pong -> ping)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pingFb);
    gl.useProgram(this.programs.sceneVibrance.program);
    bindSrcTexture(gl, this.programs.sceneVibrance, this.pongTex);
    gl.uniform1f(this.programs.sceneVibrance.uniforms['uVibrance'], model.vibrance);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 4: SceneSaturation (ping -> pong)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pongFb);
    gl.useProgram(this.programs.sceneSaturation.program);
    bindSrcTexture(gl, this.programs.sceneSaturation, this.pingTex);
    gl.uniform1f(
      this.programs.sceneSaturation.uniforms['uSaturation'],
      model.saturation,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Pass 5: AgXViewTransform (pong -> canvas backbuffer). Inline sigmoid
    // — no LUT texture; only the contrast uniform.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.programs.agxViewTransform.program);
    bindSrcTexture(gl, this.programs.agxViewTransform, this.pongTex);
    gl.uniform1f(
      this.programs.agxViewTransform.uniforms['uContrast'],
      model.contrast,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Read back the RGBA8 backbuffer. WebGL2 readPixels(RGBA, UNSIGNED_BYTE)
    // is always supported on the canvas backbuffer.
    const pixels = new Uint8ClampedArray(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.inputTex);
    gl.deleteTexture(this.pingTex);
    gl.deleteTexture(this.pongTex);
    gl.deleteFramebuffer(this.pingFb);
    gl.deleteFramebuffer(this.pongFb);
    gl.deleteVertexArray(this.vao);
    for (const p of Object.values(this.programs)) {
      gl.deleteProgram(p.program);
    }
  }
}

// === helpers ===

function compileShader(
  gl: WebGL2RenderingContext,
  type: GLenum,
  src: string,
): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? '<no info log>';
    gl.deleteShader(sh);
    throw new Error(
      `Pipeline shader compile failed (type ${type}):\n${log}\n--- source ---\n${src}`,
    );
  }
  return sh;
}

function linkProgram(
  gl: WebGL2RenderingContext,
  vs: string,
  fs: string,
  extraUniforms: readonly string[],
): ProgramHandles {
  const v = compileShader(gl, gl.VERTEX_SHADER, vs);
  const f = compileShader(gl, gl.FRAGMENT_SHADER, fs);
  const p = gl.createProgram()!;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p) ?? '<no info log>';
    gl.deleteProgram(p);
    throw new Error(`Pipeline link failed:\n${log}`);
  }
  gl.deleteShader(v);
  gl.deleteShader(f);
  const uSrc = gl.getUniformLocation(p, 'uSrc');
  if (!uSrc) throw new Error('Pipeline: uSrc location missing');
  const uniforms: Record<string, WebGLUniformLocation> = {};
  for (const name of extraUniforms) {
    const loc = gl.getUniformLocation(p, name);
    if (!loc) throw new Error(`Pipeline: uniform '${name}' location missing`);
    uniforms[name] = loc;
  }
  return { program: p, uSrc, uniforms };
}

function createFp16Texture(gl: WebGL2RenderingContext): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

function bindSrcTexture(
  gl: WebGL2RenderingContext,
  p: ProgramHandles,
  tex: WebGLTexture,
): void {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(p.uSrc, 0);
}
