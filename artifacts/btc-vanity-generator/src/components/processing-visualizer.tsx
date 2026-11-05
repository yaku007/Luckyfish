import { useEffect, useRef, useState } from "react";

type GpuTextureView = object;
type GpuTexture = { createView: () => GpuTextureView };
type GpuCommandBuffer = object;
type GpuRenderPass = {
  setPipeline: (pipeline: GpuRenderPipeline) => void;
  draw: (vertexCount: number) => void;
  end: () => void;
};
type GpuCommandEncoder = {
  beginRenderPass: (descriptor: {
    colorAttachments: {
      view: GpuTextureView;
      clearValue: { r: number; g: number; b: number; a: number };
      loadOp: "clear";
      storeOp: "store";
    }[];
  }) => GpuRenderPass;
  finish: () => GpuCommandBuffer;
};
type GpuRenderPipeline = object;
type GpuDevice = {
  queue: { submit: (commands: GpuCommandBuffer[]) => void };
  createShaderModule: (descriptor: { code: string }) => unknown;
  createRenderPipeline: (descriptor: {
    layout: "auto";
    vertex: { module: unknown; entryPoint: string };
    fragment: {
      module: unknown;
      entryPoint: string;
      targets: { format: string }[];
    };
    primitive: { topology: "triangle-list" };
  }) => GpuRenderPipeline;
  createCommandEncoder: () => GpuCommandEncoder;
  destroy: () => void;
};
type GpuAdapter = { requestDevice: () => Promise<GpuDevice> };
type GpuApi = {
  requestAdapter: () => Promise<GpuAdapter | null>;
  getPreferredCanvasFormat: () => string;
};
type GpuCanvasContext = {
  configure: (descriptor: {
    device: GpuDevice;
    format: string;
    alphaMode: "opaque";
  }) => void;
  getCurrentTexture: () => GpuTexture;
};
type CanvasWithGpu = HTMLCanvasElement & {
  getContext: (contextId: "webgpu") => GpuCanvasContext | null;
};

const GPU_SHADER = `
@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0)
  );
  return vec4f(positions[vertexIndex], 0.0, 1.0);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let glow = 0.5 + 0.5 * sin(position.x * 0.035);
  return vec4f(0.18 + glow * 0.45, 0.07 + glow * 0.17, 0.01, 1.0);
}`;

const WEBGL_VERTEX_SHADER = `#version 300 es
void main() {
  vec2 positions[3] = vec2[3](
    vec2(-1.0, -1.0),
    vec2(3.0, -1.0),
    vec2(-1.0, 3.0)
  );
  gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
}`;

const WEBGL_FRAGMENT_SHADER = `#version 300 es
precision highp float;
out vec4 outputColor;
void main() {
  float glow = 0.5 + 0.5 * sin(gl_FragCoord.x * 0.035);
  outputColor = vec4(0.18 + glow * 0.45, 0.07 + glow * 0.17, 0.01, 1.0);
}`;

function resizeCanvas(canvas: HTMLCanvasElement) {
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
}

async function initializeWebGpu(
  canvas: HTMLCanvasElement,
): Promise<() => void> {
  const gpu = Reflect.get(navigator, "gpu") as GpuApi | undefined;
  if (!gpu) throw new Error("WebGPU is not available.");

  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter is available.");

  const device = await adapter.requestDevice();
  let observer: ResizeObserver | null = null;
  try {
    const context = (canvas as CanvasWithGpu).getContext("webgpu");
    if (!context) throw new Error("Could not create a WebGPU canvas context.");

    const format = gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });
    const module = device.createShaderModule({ code: GPU_SHADER });
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vertexMain" },
      fragment: { module, entryPoint: "fragmentMain", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });

    const render = () => {
      resizeCanvas(canvas);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0.08, g: 0.035, b: 0.005, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.draw(3);
      pass.end();
      device.queue.submit([encoder.finish()]);
    };

    observer = new ResizeObserver(render);
    observer.observe(canvas);
    render();
    return () => {
      observer?.disconnect();
      device.destroy();
    };
  } catch (error) {
    observer?.disconnect();
    device.destroy();
    throw error;
  }
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not create a WebGL shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message =
      gl.getShaderInfoLog(shader) ?? "WebGL shader compilation failed.";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function initializeWebGl(canvas: HTMLCanvasElement): () => void {
  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("WebGL 2 is not available.");

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, WEBGL_VERTEX_SHADER);
  const fragmentShader = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    WEBGL_FRAGMENT_SHADER,
  );
  const program = gl.createProgram();
  if (!program) throw new Error("Could not create a WebGL program.");
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message =
      gl.getProgramInfoLog(program) ?? "WebGL program linking failed.";
    gl.deleteProgram(program);
    throw new Error(message);
  }

  const render = () => {
    resizeCanvas(canvas);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const observer = new ResizeObserver(render);
  observer.observe(canvas);
  render();

  return () => {
    observer.disconnect();
    gl.deleteProgram(program);
  };
}

function initializeCanvas2d(canvas: HTMLCanvasElement): () => void {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas visualization is not available.");
  const render = () => {
    resizeCanvas(canvas);
    const gradient = context.createLinearGradient(0, 0, canvas.width, 0);
    gradient.addColorStop(0, "#512407");
    gradient.addColorStop(0.5, "#d87516");
    gradient.addColorStop(1, "#512407");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
  };
  const observer = new ResizeObserver(render);
  observer.observe(canvas);
  render();
  return () => observer.disconnect();
}

export default function ProcessingVisualizer({
  active,
  attempts,
}: {
  active: boolean;
  attempts: number;
}) {
  const webGpuCanvas = useRef<HTMLCanvasElement>(null);
  const webGlCanvas = useRef<HTMLCanvasElement>(null);
  const canvas2d = useRef<HTMLCanvasElement>(null);
  const [renderer, setRenderer] = useState("Starting visualization…");
  const [layer, setLayer] = useState<"webgpu" | "webgl" | "canvas" | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};

    const initialize = async () => {
      try {
        cleanup = await initializeWebGpu(webGpuCanvas.current!);
        if (cancelled) cleanup();
        else {
          setLayer("webgpu");
          setRenderer("WebGPU rendering");
        }
        return;
      } catch {
        if (cancelled) return;
      }

      try {
        cleanup = initializeWebGl(webGlCanvas.current!);
        if (cancelled) cleanup();
        else {
          setLayer("webgl");
          setRenderer("WebGL 2 rendering · WebGPU unavailable");
        }
        return;
      } catch {
        if (cancelled) return;
      }

      try {
        cleanup = initializeCanvas2d(canvas2d.current!);
        if (cancelled) cleanup();
        else {
          setLayer("canvas");
          setRenderer("Canvas 2D rendering · GPU renderers unavailable");
        }
      } catch {
        if (!cancelled) {
          setLayer(null);
          setRenderer("Visualization unavailable");
        }
      }
    };

    void initialize();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  return (
    <div
      className={`processing-visualizer ${active ? "processing-active" : ""}`}
      role="img"
      aria-label={`Local worker activity visualization. ${renderer}. GPU rendering is visual only; all address work stays in web workers.`}
    >
      <div className="processing-visual-copy">
        <span className="processing-visual-label">{renderer}</span>
        <span className="processing-visual-detail">
          {attempts.toLocaleString()} attempts · workers perform all address
          operations
        </span>
      </div>
      <div className="processing-canvas-stack" aria-hidden="true">
        <canvas
          ref={webGpuCanvas}
          className={layer === "webgpu" ? "visible" : ""}
        />
        <canvas
          ref={webGlCanvas}
          className={layer === "webgl" ? "visible" : ""}
        />
        <canvas
          ref={canvas2d}
          className={layer === "canvas" ? "visible" : ""}
        />
      </div>
    </div>
  );
}
