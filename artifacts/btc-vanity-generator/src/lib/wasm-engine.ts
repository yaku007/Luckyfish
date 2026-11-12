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
        this.memory = new WebAssembly.Memory({ initial: 256, maximum: 512 });
        const module = await WebAssembly.instantiate(buffer, {
          env: {
            memory: this.memory,
            abort: () => {},
          }
        });
        this.instance = module.instance.exports;
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

  // هاد الدالة كتاخد Array ديال المفاتيح وكتزيدهم كاملين بـ 1
  incrementKeys(keysBuffer: Uint8Array, count: number): void {
    if (!this.instance || !this.memory) return;

    // 1. نلقاو فين كاين الـ Memory Pointer
    const mem = new Uint8Array(this.memory.buffer);
    
    // 2. نكتبو المفاتيح فالذاكرة (فـ الأول ديال الـ Memory)
    mem.set(keysBuffer, 0);

    // 3. كنعيطو للدالة ديال C++ (كتاخد المؤشر 0 وعدد المفاتيح)
    this.instance.increment_keys(0, count);

    // 4. كنقراو المفاتيح الجديدة من الذاكرة ونرجعوهم
    keysBuffer.set(mem.slice(0, count * 32));
  }
}
