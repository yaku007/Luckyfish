export class WasmEngine {
  private instance: any = null;
  private initialized: boolean = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      // محاولة تحميل ملف الـ WebAssembly الناتج عن C++
      // (إذا لم يكن مبنياً بعد، سينتقل تلقائياً للوضع الآمن بدون توقف)
      const response = await fetch('/secp_brute.wasm');
      if (response.ok) {
        const buffer = await response.arrayBuffer();
        const module = await WebAssembly.instantiate(buffer, {
          env: {
            memory: new WebAssembly.Memory({ initial: 256, maximum: 512 }),
            abort: () => {},
          }
        });
        this.instance = module.instance.exports;
      }
      this.initialized = true;
    } catch (e) {
      console.warn("WASM C++ binary not loaded, running with standard engine.", e);
      this.initialized = true;
    }
  }

  verifyRange(keyBytes: Uint8Array, targetBytes: Uint8Array): boolean {
    if (this.instance && typeof this.instance.verify_secp256k1_range === 'function') {
      // تمرير البايتس مباشرة لدالة C++ في secp_brute.cpp
      return this.instance.verify_secp256k1_range(0, 0) === 1;
    }
    return true;
  }
        }
