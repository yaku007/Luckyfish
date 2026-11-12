#include <emscripten/emscripten.h>
#include <stdint.h>

extern "C" {

// دالة كتاخد مؤشر على Array ديال المفاتيح، وعدد المفاتيح، وكتزيد كل مفتاح بـ 1
EMSCRIPTEN_KEEPALIVE
void increment_keys(uint8_t* keys_ptr, uint32_t count) {
    for (uint32_t i = 0; i < count; i++) {
        uint8_t* current_key = keys_ptr + (i * 32);
        // الزيادة بـ 1 (BigInt Increment)
        for (int j = 31; j >= 0; j--) {
            if (++current_key[j] != 0) {
                break;
            }
        }
    }
}

}
