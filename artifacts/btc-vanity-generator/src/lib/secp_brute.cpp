#include <stdint.h>
#include <emscripten/emscripten.h>

extern "C" {

EMSCRIPTEN_KEEPALIVE
void increment_keys(uint8_t* keys_ptr, int count) {
    for (int i = 0; i < count; i++) {
        uint8_t* current_key = keys_ptr + (i * 32);
        for (int j = 31; j >= 0; j--) {
            current_key[j]++;
            if (current_key[j] != 0) {
                break;
            }
        }
    }
}

}
