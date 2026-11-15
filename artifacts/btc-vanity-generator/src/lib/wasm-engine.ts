export class WasmEngine {
  private instance: any = null;
  private initialized: boolean = false;
  private memory: WebAssembly.Memory | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const response = await fetch('/secp_brute.wasm');
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        // في WasmBolt/Godbolt، الذاكرة كتكون مدمجة فـ الملف (Standalone Wasm)
        const module = await WebAssembly.instantiate(buffer, {
          env: {
            abort: () => {},
          }
        });
        this.instance = module.instance.exports;
        // نلقاو الذاكرة اللي تصدرات من الـ Wasm
        this.memory = this.instance.memory;
      }
      this.initialized = true;
    } catch (e) {
      console.warn("WASM binary not loaded, using fallback.", e);
      this.initialized = true;
    }
  }

  isReady(): boolean {
    return this.instance !== null && this.memory !== null;
  }

  incrementKeys(keysBuffer: Uint8Array, count: number): void {
    if (!this.instance || !this.memory) return;

    const mem = new Uint8Array(this.memory.buffer);
    
    // نكتبو المفاتيح فالذاكرة (فـ الأول ديال الـ Memory)
    mem.set(keysBuffer, 0);

    // كنعيطو للدالة ديال C++ (كتاخد المؤشر 0 وعدد المفاتيح)
    this.instance.increment_keys(0, count);

    // كنقراو المفاتيح الجديدة من الذاكرة ونرجعوهم
    keysBuffer.set(mem.slice(0, count * 32));
  }
}
