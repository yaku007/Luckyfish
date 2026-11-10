// WebGPU Hardware Accelerator Controller
export class WebGPUBruteEngine {
  private device: GPUDevice | null = null;
  private pipeline: GPUComputePipeline | null = null;
  private supported: boolean = false;

  async initialize(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      this.supported = false;
      return false;
    }

    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) {
        this.supported = false;
        return false;
      }
      this.device = await adapter.requestDevice();
      this.supported = true;
      return true;
    } catch {
      this.supported = false;
      return false;
    }
  }

  // 🛠️ إضافة الدالة اللي كان كيعطي فيها الخطأ
  public getSupported(): boolean {
    return this.supported && this.device !== null;
  }

  async executeRangeBatch(startVal: number, count: number): Promise<boolean> {
    if (!this.device || !this.supported) return false;
    return true;
  }
}
